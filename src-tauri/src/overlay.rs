//! Overlay policy and preferences, independent of UDP, recording and HWNDs.
use serde::{Deserialize, Deserializer, Serialize};

pub const UPDATE_MS: u64 = 100;
// Phase C family limits. Contract-tested against f1-freshness.ts.
pub const FRESH_MS: u64 = 1000;
pub const STALE_MS: u64 = 3000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OverlayPreferences {
    pub enabled: bool,
    /// Physical desktop coordinates; may be negative on a secondary monitor.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Unscaled logical client size. OS DPI and user scale are independent.
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub opacity: f64,
}

impl Default for OverlayPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            x: None,
            y: None,
            width: 440.0,
            height: 210.0,
            scale: 1.0,
            opacity: 0.9,
        }
    }
}

impl OverlayPreferences {
    pub fn validate(&self) -> Result<(), String> {
        if !self.width.is_finite()
            || !(360.0..=880.0).contains(&self.width)
            || !self.height.is_finite()
            || !(210.0..=600.0).contains(&self.height)
            || !self.scale.is_finite()
            || !(0.75..=1.5).contains(&self.scale)
            || !self.opacity.is_finite()
            || !(0.3..=1.0).contains(&self.opacity)
            || self.x.is_some() != self.y.is_some()
        {
            return Err("Invalid overlay size, position, scale or opacity".into());
        }
        Ok(())
    }
}

/// An invalid new section must not discard the user's old storage/setup data.
pub fn read_preferences<'de, D: Deserializer<'de>>(d: D) -> Result<OverlayPreferences, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<OverlayPreferences>(value)
        .ok()
        .filter(|p| p.validate().is_ok())
        .unwrap_or_default())
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OverlayPolicy {
    pub editing: bool,
    pub visible: bool,
    pub shutdown: bool,
}

impl OverlayPolicy {
    /// Fresh telemetry opens; an already visible window tolerates Phase C's
    /// stale interval. Unavailable, another active game or disable closes.
    /// Main minimization is deliberately absent from this decision.
    pub fn update(&mut self, enabled: bool, f1_age: Option<u64>, fh6_active: bool) {
        if !enabled {
            self.editing = false;
        }
        self.visible = !self.shutdown
            && enabled
            && !fh6_active
            && (self.editing
                || f1_age.is_some_and(|age| age <= if self.visible { STALE_MS } else { FRESH_MS }));
    }
    pub fn stop(&mut self) {
        self.shutdown = true;
        self.editing = false;
        self.visible = false;
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Display {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub dpi: f64,
}

/// Recover the whole window onto a real display, including negative origins
/// and mixed DPI. Prefer the saved display; otherwise use primary-first order.
pub fn recover(p: &OverlayPreferences, displays: &[Display]) -> OverlayPreferences {
    let Some(first) = displays.first() else {
        return p.clone();
    };
    let display = displays
        .iter()
        .find(|m| {
            p.x.zip(p.y).is_some_and(|(x, y)| {
                x >= m.x
                    && y >= m.y
                    && i64::from(x) < i64::from(m.x) + i64::from(m.width)
                    && i64::from(y) < i64::from(m.y) + i64::from(m.height)
            })
        })
        .unwrap_or(first);
    let mut result = p.clone();
    let factor = p.scale * display.dpi;
    result.width = p.width.min(f64::from(display.width) / factor);
    result.height = p.height.min(f64::from(display.height) / factor);
    let width = ((result.width * factor).ceil() as i64).min(i64::from(display.width));
    let height = ((result.height * factor).ceil() as i64).min(i64::from(display.height));
    result.x = Some(
        i64::from(p.x.unwrap_or(display.x.saturating_add(24))).clamp(
            i64::from(display.x),
            i64::from(display.x) + i64::from(display.width) - width,
        ) as i32,
    );
    result.y = Some(
        i64::from(p.y.unwrap_or(display.y.saturating_add(24))).clamp(
            i64::from(display.y),
            i64::from(display.y) + i64::from(display.height) - height,
        ) as i32,
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_hysteresis_disable_other_game_edit_and_shutdown() {
        let mut p = OverlayPolicy::default();
        p.update(false, Some(0), false);
        assert!(!p.visible);
        p.update(true, Some(1001), false);
        assert!(!p.visible);
        p.update(true, Some(1000), false);
        assert!(p.visible);
        p.update(true, Some(3000), false);
        assert!(p.visible);
        p.update(true, Some(3001), false);
        assert!(!p.visible);
        p.update(true, Some(0), true);
        assert!(!p.visible);
        p.editing = true;
        p.update(true, None, true);
        assert!(!p.visible);
        p.update(true, None, false);
        assert!(p.visible);
        p.editing = false;
        p.update(true, None, false);
        assert!(!p.visible);
        p.update(true, Some(0), false);
        assert!(p.visible); // independent of main minimization
        p.stop();
        p.update(true, Some(0), false);
        assert!(!p.visible);
    }
    #[test]
    fn invalid_values_are_rejected_and_missing_fields_default() {
        let p: OverlayPreferences = serde_json::from_str("{\"enabled\":true}").unwrap();
        assert!(p.enabled);
        assert_eq!(p.scale, 1.0);
        for bad in [f64::NAN, f64::INFINITY, 0.0, 1.51] {
            assert!(OverlayPreferences {
                scale: bad,
                ..p.clone()
            }
            .validate()
            .is_err());
        }
        for invalid in [
            OverlayPreferences {
                x: Some(1),
                ..p.clone()
            },
            OverlayPreferences {
                width: 359.0,
                ..p.clone()
            },
            OverlayPreferences {
                height: 601.0,
                ..p.clone()
            },
            OverlayPreferences {
                opacity: 0.29,
                ..p.clone()
            },
            OverlayPreferences {
                opacity: f64::NAN,
                ..p.clone()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }
    #[test]
    fn removed_monitor_and_mixed_dpi_recover_without_resolution_assumptions() {
        let displays = [
            Display {
                x: 0,
                y: 0,
                width: 1366,
                height: 768,
                dpi: 1.0,
            },
            Display {
                x: -1920,
                y: -80,
                width: 1920,
                height: 1080,
                dpi: 1.5,
            },
        ];
        let p = OverlayPreferences {
            x: Some(9000),
            y: Some(-9000),
            scale: 1.5,
            ..Default::default()
        };
        let fixed = recover(&p, &displays);
        assert_eq!(fixed.x, Some(706));
        assert_eq!(fixed.y, Some(0));
        let p = OverlayPreferences {
            x: Some(-100),
            y: Some(999),
            ..p
        };
        let fixed = recover(&p, &displays);
        assert_eq!(fixed.x, Some(-990));
        assert_eq!(fixed.y, Some(527));
        assert_eq!(recover(&p, &[]), p);
    }
    #[test]
    fn preferences_roundtrip_preserves_old_settings_and_corrupt_section_is_isolated() {
        let dir =
            std::env::temp_dir().join(format!("racelab-overlay-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), r#"{"storage_budget_bytes":10737418240,"fh6_first_detected_unix_ms":123,"overlay":{"scale":99}}"#).unwrap();
        let s = crate::settings::SettingsStore::load(&dir, 8);
        assert_eq!(s.storage_budget_bytes(), 10737418240);
        assert!(!s.overlay().enabled);
        let p = OverlayPreferences {
            enabled: true,
            x: Some(-123),
            y: Some(44),
            width: 600.0,
            height: 230.0,
            scale: 1.25,
            opacity: 0.7,
        };
        s.set_overlay(p.clone()).unwrap();
        let loaded = crate::settings::SettingsStore::load(&dir, 8);
        assert_eq!(loaded.overlay(), p);
        assert_eq!(loaded.fh6_first_detected_unix_ms(), Some(123));
        assert_eq!(loaded.storage_budget_bytes(), 10737418240);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
