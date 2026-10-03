//! Coded fields, with exactly the meanings the F1 25 v3 specification gives.
//!
//! Every code keeps its raw wire value. A value the specification does not
//! name decodes to `Unknown(raw)` and is never mapped to the nearest known
//! meaning. Serialized as `{ "raw": <wire value>, "label": <name or null> }`.
//!
//! Where the specification describes a field only as "whether ..." without
//! stating which value means what, it is not a code and stays a raw integer
//! in its struct.

macro_rules! code {
    (
        $(#[$meta:meta])*
        $name:ident: $raw:ty {
            $($variant:ident = $value:literal => $label:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant,)+
            Unknown($raw),
        }

        impl $name {
            pub fn from_raw(raw: $raw) -> Self {
                match raw {
                    $($value => Self::$variant,)+
                    other => Self::Unknown(other),
                }
            }

            pub fn raw(self) -> $raw {
                match self {
                    $(Self::$variant => $value,)+
                    Self::Unknown(raw) => raw,
                }
            }

            /// The specification's meaning, or `None` for `Unknown`.
            pub fn label(self) -> Option<&'static str> {
                match self {
                    $(Self::$variant => Some($label),)+
                    Self::Unknown(_) => None,
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeStruct;
                let mut out = serializer.serialize_struct(stringify!($name), 2)?;
                out.serialize_field("raw", &self.raw())?;
                out.serialize_field("label", &self.label())?;
                out.end()
            }
        }
    };
}

// ------------------------------------------------------------ car telemetry

code! {
    /// `m_gear`: "Gear selected (1-8, N=0, R=-1)".
    Gear: i8 {
        Reverse = -1 => "R",
        Neutral = 0 => "N",
        First = 1 => "1",
        Second = 2 => "2",
        Third = 3 => "3",
        Fourth = 4 => "4",
        Fifth = 5 => "5",
        Sixth = 6 => "6",
        Seventh = 7 => "7",
        Eighth = 8 => "8",
    }
}

code! {
    /// `m_suggestedGear`: "Suggested gear for the player (1-8), 0 if no gear
    /// suggested".
    SuggestedGear: i8 {
        NoSuggestion = 0 => "none",
        First = 1 => "1",
        Second = 2 => "2",
        Third = 3 => "3",
        Fourth = 4 => "4",
        Fifth = 5 => "5",
        Sixth = 6 => "6",
        Seventh = 7 => "7",
        Eighth = 8 => "8",
    }
}

code! {
    /// `m_drs`: "0 = off, 1 = on".
    Drs: u8 {
        Off = 0 => "off",
        On = 1 => "on",
    }
}

code! {
    /// `m_mfdPanelIndex`: "255 = MFD closed. Single player, race – 0 = Car
    /// setup, 1 = Pits, 2 = Damage, 3 = Engine, 4 = Temperatures. May vary
    /// depending on game mode". The labels are the single-player race panels.
    MfdPanel: u8 {
        CarSetup = 0 => "car setup",
        Pits = 1 => "pits",
        Damage = 2 => "damage",
        Engine = 3 => "engine",
        Temperatures = 4 => "temperatures",
        Closed = 255 => "closed",
    }
}

code! {
    /// Appendix "Surface types": "what type of contact each wheel is
    /// experiencing".
    SurfaceType: u8 {
        Tarmac = 0 => "tarmac",
        RumbleStrip = 1 => "rumble strip",
        Concrete = 2 => "concrete",
        Rock = 3 => "rock",
        Gravel = 4 => "gravel",
        Mud = 5 => "mud",
        Sand = 6 => "sand",
        Grass = 7 => "grass",
        Water = 8 => "water",
        Cobblestone = 9 => "cobblestone",
        Metal = 10 => "metal",
        Ridged = 11 => "ridged",
    }
}

// --------------------------------------------------------------- car status

code! {
    /// `m_tractionControl`: "0 = off, 1 = medium, 2 = full".
    TractionControl: u8 {
        Off = 0 => "off",
        Medium = 1 => "medium",
        Full = 2 => "full",
    }
}

code! {
    /// `m_antiLockBrakes`: "0 (off) - 1 (on)".
    AntiLockBrakes: u8 {
        Off = 0 => "off",
        On = 1 => "on",
    }
}

code! {
    /// `m_fuelMix`: "0 = lean, 1 = standard, 2 = rich, 3 = max".
    FuelMix: u8 {
        Lean = 0 => "lean",
        Standard = 1 => "standard",
        Rich = 2 => "rich",
        Max = 3 => "max",
    }
}

code! {
    /// `m_pitLimiterStatus`: "0 = off, 1 = on".
    PitLimiter: u8 {
        Off = 0 => "off",
        On = 1 => "on",
    }
}

code! {
    /// `m_drsAllowed`: "0 = not allowed, 1 = allowed".
    DrsAllowed: u8 {
        NotAllowed = 0 => "not allowed",
        Allowed = 1 => "allowed",
    }
}

code! {
    /// `m_actualTyreCompound`: "F1 Modern - 16 = C5, 17 = C4, 18 = C3,
    /// 19 = C2, 20 = C1, 21 = C0, 22 = C6, 7 = inter, 8 = wet; F1 Classic -
    /// 9 = dry, 10 = wet; F2 – 11 = super soft, 12 = soft, 13 = medium,
    /// 14 = hard, 15 = wet".
    ActualTyreCompound: u8 {
        Inter = 7 => "inter",
        Wet = 8 => "wet",
        ClassicDry = 9 => "classic dry",
        ClassicWet = 10 => "classic wet",
        F2SuperSoft = 11 => "F2 super soft",
        F2Soft = 12 => "F2 soft",
        F2Medium = 13 => "F2 medium",
        F2Hard = 14 => "F2 hard",
        F2Wet = 15 => "F2 wet",
        C5 = 16 => "C5",
        C4 = 17 => "C4",
        C3 = 18 => "C3",
        C2 = 19 => "C2",
        C1 = 20 => "C1",
        C0 = 21 => "C0",
        C6 = 22 => "C6",
    }
}

code! {
    /// `m_visualTyreCompound`: "F1 visual (can be different from actual
    /// compound) 16 = soft, 17 = medium, 18 = hard, 7 = inter, 8 = wet; F1
    /// Classic – same as above; F2 '20, 15 = wet, 19 – super soft,
    /// 20 = soft, 21 = medium, 22 = hard".
    VisualTyreCompound: u8 {
        Inter = 7 => "inter",
        Wet = 8 => "wet",
        F2Wet = 15 => "F2 wet",
        Soft = 16 => "soft",
        Medium = 17 => "medium",
        Hard = 18 => "hard",
        F2SuperSoft = 19 => "F2 super soft",
        F2Soft = 20 => "F2 soft",
        F2Medium = 21 => "F2 medium",
        F2Hard = 22 => "F2 hard",
    }
}

code! {
    /// `m_vehicleFiaFlags`: "-1 = invalid/unknown, 0 = none, 1 = green,
    /// 2 = blue, 3 = yellow".
    FiaFlag: i8 {
        InvalidOrUnknown = -1 => "invalid/unknown",
        NoFlag = 0 => "none",
        Green = 1 => "green",
        Blue = 2 => "blue",
        Yellow = 3 => "yellow",
    }
}

code! {
    /// `m_ersDeployMode`: "0 = none, 1 = medium, 2 = hotlap, 3 = overtake".
    ErsDeployMode: u8 {
        NoDeployment = 0 => "none",
        Medium = 1 => "medium",
        Hotlap = 2 => "hotlap",
        Overtake = 3 => "overtake",
    }
}

// ----------------------------------------------------------------- lap data

code! {
    /// `m_pitStatus`: "0 = none, 1 = pitting, 2 = in pit area".
    PitStatus: u8 {
        NotPitting = 0 => "none",
        Pitting = 1 => "pitting",
        InPitArea = 2 => "in pit area",
    }
}

code! {
    /// `m_sector`: "0 = sector1, 1 = sector2, 2 = sector3".
    Sector: u8 {
        Sector1 = 0 => "sector 1",
        Sector2 = 1 => "sector 2",
        Sector3 = 2 => "sector 3",
    }
}

code! {
    /// `m_currentLapInvalid`: "0 = valid, 1 = invalid".
    LapValidity: u8 {
        Valid = 0 => "valid",
        Invalid = 1 => "invalid",
    }
}

code! {
    /// `m_driverStatus`: "0 = in garage, 1 = flying lap, 2 = in lap,
    /// 3 = out lap, 4 = on track".
    DriverStatus: u8 {
        InGarage = 0 => "in garage",
        FlyingLap = 1 => "flying lap",
        InLap = 2 => "in lap",
        OutLap = 3 => "out lap",
        OnTrack = 4 => "on track",
    }
}

code! {
    /// `m_resultStatus`: "0 = invalid, 1 = inactive, 2 = active,
    /// 3 = finished, 4 = didnotfinish, 5 = disqualified, 6 = not classified,
    /// 7 = retired".
    ResultStatus: u8 {
        Invalid = 0 => "invalid",
        Inactive = 1 => "inactive",
        Active = 2 => "active",
        Finished = 3 => "finished",
        DidNotFinish = 4 => "did not finish",
        Disqualified = 5 => "disqualified",
        NotClassified = 6 => "not classified",
        Retired = 7 => "retired",
    }
}

code! {
    /// `m_pitLaneTimerActive`: "0 = inactive, 1 = active".
    PitLaneTimer: u8 {
        Inactive = 0 => "inactive",
        Active = 1 => "active",
    }
}

// ------------------------------------------------------------------ session

code! {
    /// `m_weather` (also each forecast sample's): "0 = clear, 1 = light
    /// cloud, 2 = overcast, 3 = light rain, 4 = heavy rain, 5 = storm".
    Weather: u8 {
        Clear = 0 => "clear",
        LightCloud = 1 => "light cloud",
        Overcast = 2 => "overcast",
        LightRain = 3 => "light rain",
        HeavyRain = 4 => "heavy rain",
        Storm = 5 => "storm",
    }
}

code! {
    /// `m_sessionType`, appendix "Session types". 0 is the specification's
    /// own "Unknown": a named value, not `Unknown(raw)`.
    SessionType: u8 {
        UnknownSession = 0 => "unknown",
        Practice1 = 1 => "Practice 1",
        Practice2 = 2 => "Practice 2",
        Practice3 = 3 => "Practice 3",
        ShortPractice = 4 => "Short Practice",
        Qualifying1 = 5 => "Qualifying 1",
        Qualifying2 = 6 => "Qualifying 2",
        Qualifying3 = 7 => "Qualifying 3",
        ShortQualifying = 8 => "Short Qualifying",
        OneShotQualifying = 9 => "One-Shot Qualifying",
        SprintShootout1 = 10 => "Sprint Shootout 1",
        SprintShootout2 = 11 => "Sprint Shootout 2",
        SprintShootout3 = 12 => "Sprint Shootout 3",
        ShortSprintShootout = 13 => "Short Sprint Shootout",
        OneShotSprintShootout = 14 => "One-Shot Sprint Shootout",
        Race = 15 => "Race",
        Race2 = 16 => "Race 2",
        Race3 = 17 => "Race 3",
        TimeTrial = 18 => "Time Trial",
    }
}

code! {
    /// `m_formula`: "0 = F1 Modern, 1 = F1 Classic, 2 = F2, 3 = F1 Generic,
    /// 4 = Beta, 6 = Esports, 8 = F1 World, 9 = F1 Elimination".
    Formula: u8 {
        F1Modern = 0 => "F1 Modern",
        F1Classic = 1 => "F1 Classic",
        F2 = 2 => "F2",
        F1Generic = 3 => "F1 Generic",
        Beta = 4 => "Beta",
        Esports = 6 => "Esports",
        F1World = 8 => "F1 World",
        F1Elimination = 9 => "F1 Elimination",
    }
}

code! {
    /// `m_safetyCarStatus`: "0 = no safety car, 1 = full, 2 = virtual,
    /// 3 = formation lap". The Safety Car event's `safetyCarType` uses the
    /// same four values.
    SafetyCarStatus: u8 {
        NoSafetyCar = 0 => "no safety car",
        Full = 1 => "full",
        Virtual = 2 => "virtual",
        FormationLap = 3 => "formation lap",
    }
}

code! {
    /// `m_networkGame`: "0 = offline, 1 = online".
    NetworkGame: u8 {
        Offline = 0 => "offline",
        Online = 1 => "online",
    }
}

code! {
    /// `m_trackId`: "-1 for unknown, see appendix" ("Track IDs").
    TrackId: i8 {
        UnknownTrack = -1 => "unknown",
        Melbourne = 0 => "Melbourne",
        Shanghai = 2 => "Shanghai",
        Sakhir = 3 => "Sakhir (Bahrain)",
        Catalunya = 4 => "Catalunya",
        Monaco = 5 => "Monaco",
        Montreal = 6 => "Montreal",
        Silverstone = 7 => "Silverstone",
        Hungaroring = 9 => "Hungaroring",
        Spa = 10 => "Spa",
        Monza = 11 => "Monza",
        Singapore = 12 => "Singapore",
        Suzuka = 13 => "Suzuka",
        AbuDhabi = 14 => "Abu Dhabi",
        Texas = 15 => "Texas",
        Brazil = 16 => "Brazil",
        Austria = 17 => "Austria",
        Mexico = 19 => "Mexico",
        Baku = 20 => "Baku (Azerbaijan)",
        Zandvoort = 26 => "Zandvoort",
        Imola = 27 => "Imola",
        Jeddah = 29 => "Jeddah",
        Miami = 30 => "Miami",
        LasVegas = 31 => "Las Vegas",
        Losail = 32 => "Losail",
        SilverstoneReverse = 39 => "Silverstone (Reverse)",
        AustriaReverse = 40 => "Austria (Reverse)",
        ZandvoortReverse = 41 => "Zandvoort (Reverse)",
    }
}

code! {
    /// `m_gameMode`, appendix "Game Mode IDs".
    GameMode: u8 {
        GrandPrix23 = 4 => "Grand Prix '23",
        TimeTrial = 5 => "Time Trial",
        Splitscreen = 6 => "Splitscreen",
        OnlineCustom = 7 => "Online Custom",
        OnlineWeeklyEvent = 15 => "Online Weekly Event",
        StoryModeBrakingPoint = 17 => "Story Mode (Braking Point)",
        MyTeamCareer25 = 27 => "My Team Career '25",
        DriverCareer25 = 28 => "Driver Career '25",
        Career25Online = 29 => "Career '25 Online",
        ChallengeCareer25 = 30 => "Challenge Career '25",
        StoryModeApxgp = 75 => "Story Mode (APXGP)",
        Benchmark = 127 => "Benchmark",
    }
}

code! {
    /// `m_ruleSet`, appendix "Ruleset IDs".
    RuleSet: u8 {
        PracticeAndQualifying = 0 => "Practice & Qualifying",
        Race = 1 => "Race",
        TimeTrial = 2 => "Time Trial",
        Elimination = 12 => "Elimination",
    }
}

code! {
    /// Appendix "Team IDs".
    TeamId: u8 {
        Mercedes = 0 => "Mercedes",
        Ferrari = 1 => "Ferrari",
        RedBullRacing = 2 => "Red Bull Racing",
        Williams = 3 => "Williams",
        AstonMartin = 4 => "Aston Martin",
        Alpine = 5 => "Alpine",
        Rb = 6 => "RB",
        Haas = 7 => "Haas",
        McLaren = 8 => "McLaren",
        Sauber = 9 => "Sauber",
        F1Generic = 41 => "F1 Generic",
        F1CustomTeam = 104 => "F1 Custom Team",
        Konnersport = 129 => "Konnersport",
        Apxgp24 = 142 => "APXGP '24",
        Apxgp25 = 154 => "APXGP '25",
        Konnersport24 = 155 => "Konnersport '24",
        ArtGp24 = 158 => "Art GP '24",
        Campos24 = 159 => "Campos '24",
        RodinMotorsport24 = 160 => "Rodin Motorsport '24",
        AixRacing24 = 161 => "AIX Racing '24",
        Dams24 = 162 => "DAMS '24",
        Hitech24 = 163 => "Hitech '24",
        MpMotorsport24 = 164 => "MP Motorsport '24",
        Prema24 = 165 => "Prema '24",
        Trident24 = 166 => "Trident '24",
        VanAmersfoortRacing24 = 167 => "Van Amersfoort Racing '24",
        Invicta24 = 168 => "Invicta '24",
        Mercedes24 = 185 => "Mercedes '24",
        Ferrari24 = 186 => "Ferrari '24",
        RedBullRacing24 = 187 => "Red Bull Racing '24",
        Williams24 = 188 => "Williams '24",
        AstonMartin24 = 189 => "Aston Martin '24",
        Alpine24 = 190 => "Alpine '24",
        Rb24 = 191 => "RB '24",
        Haas24 = 192 => "Haas '24",
        McLaren24 = 193 => "McLaren '24",
        Sauber24 = 194 => "Sauber '24",
    }
}

// ------------------------------------------------------ results and events

code! {
    /// Final Classification `m_resultReason`, and the Retirement event's
    /// `reason`: "0 = invalid, 1 = retired, 2 = finished, 3 = terminal
    /// damage, 4 = inactive, 5 = not enough laps completed, 6 = black
    /// flagged, 7 = red flagged, 8 = mechanical failure, 9 = session
    /// skipped, 10 = session simulated".
    ResultReason: u8 {
        Invalid = 0 => "invalid",
        Retired = 1 => "retired",
        Finished = 2 => "finished",
        TerminalDamage = 3 => "terminal damage",
        Inactive = 4 => "inactive",
        NotEnoughLapsCompleted = 5 => "not enough laps completed",
        BlackFlagged = 6 => "black flagged",
        RedFlagged = 7 => "red flagged",
        MechanicalFailure = 8 => "mechanical failure",
        SessionSkipped = 9 => "session skipped",
        SessionSimulated = 10 => "session simulated",
    }
}

code! {
    /// DRS Disabled event `reason`: "0 = Wet track, 1 = Safety car deployed,
    /// 2 = Red flag, 3 = Min lap not reached".
    DrsDisabledReason: u8 {
        WetTrack = 0 => "wet track",
        SafetyCarDeployed = 1 => "safety car deployed",
        RedFlag = 2 => "red flag",
        MinLapNotReached = 3 => "min lap not reached",
    }
}

code! {
    /// Safety Car event `eventType`: "0 = Deployed, 1 = Returning,
    /// 2 = Returned, 3 = Resume Race".
    SafetyCarEventType: u8 {
        Deployed = 0 => "deployed",
        Returning = 1 => "returning",
        Returned = 2 => "returned",
        ResumeRace = 3 => "resume race",
    }
}

code! {
    /// Appendix "Penalty types".
    PenaltyType: u8 {
        DriveThrough = 0 => "Drive through",
        StopGo = 1 => "Stop Go",
        GridPenalty = 2 => "Grid penalty",
        PenaltyReminder = 3 => "Penalty reminder",
        TimePenalty = 4 => "Time penalty",
        Warning = 5 => "Warning",
        Disqualified = 6 => "Disqualified",
        RemovedFromFormationLap = 7 => "Removed from formation lap",
        ParkedTooLongTimer = 8 => "Parked too long timer",
        TyreRegulations = 9 => "Tyre regulations",
        ThisLapInvalidated = 10 => "This lap invalidated",
        ThisAndNextLapInvalidated = 11 => "This and next lap invalidated",
        ThisLapInvalidatedWithoutReason = 12 => "This lap invalidated without reason",
        ThisAndNextLapInvalidatedWithoutReason = 13 => "This and next lap invalidated without reason",
        ThisAndPreviousLapInvalidated = 14 => "This and previous lap invalidated",
        ThisAndPreviousLapInvalidatedWithoutReason = 15 => "This and previous lap invalidated without reason",
        Retired = 16 => "Retired",
        BlackFlagTimer = 17 => "Black flag timer",
    }
}

code! {
    /// Appendix "Infringement types".
    InfringementType: u8 {
        BlockingBySlowDriving = 0 => "Blocking by slow driving",
        BlockingByWrongWayDriving = 1 => "Blocking by wrong way driving",
        ReversingOffTheStartLine = 2 => "Reversing off the start line",
        BigCollision = 3 => "Big Collision",
        SmallCollision = 4 => "Small Collision",
        CollisionFailedToHandBackPositionSingle = 5 => "Collision failed to hand back position single",
        CollisionFailedToHandBackPositionMultiple = 6 => "Collision failed to hand back position multiple",
        CornerCuttingGainedTime = 7 => "Corner cutting gained time",
        CornerCuttingOvertakeSingle = 8 => "Corner cutting overtake single",
        CornerCuttingOvertakeMultiple = 9 => "Corner cutting overtake multiple",
        CrossedPitExitLane = 10 => "Crossed pit exit lane",
        IgnoringBlueFlags = 11 => "Ignoring blue flags",
        IgnoringYellowFlags = 12 => "Ignoring yellow flags",
        IgnoringDriveThrough = 13 => "Ignoring drive through",
        TooManyDriveThroughs = 14 => "Too many drive throughs",
        DriveThroughReminderServeWithinNLaps = 15 => "Drive through reminder serve within n laps",
        DriveThroughReminderServeThisLap = 16 => "Drive through reminder serve this lap",
        PitLaneSpeeding = 17 => "Pit lane speeding",
        ParkedForTooLong = 18 => "Parked for too long",
        IgnoringTyreRegulations = 19 => "Ignoring tyre regulations",
        TooManyPenalties = 20 => "Too many penalties",
        MultipleWarnings = 21 => "Multiple warnings",
        ApproachingDisqualification = 22 => "Approaching disqualification",
        TyreRegulationsSelectSingle = 23 => "Tyre regulations select single",
        TyreRegulationsSelectMultiple = 24 => "Tyre regulations select multiple",
        LapInvalidatedCornerCutting = 25 => "Lap invalidated corner cutting",
        LapInvalidatedRunningWide = 26 => "Lap invalidated running wide",
        CornerCuttingRanWideGainedTimeMinor = 27 => "Corner cutting ran wide gained time minor",
        CornerCuttingRanWideGainedTimeSignificant = 28 => "Corner cutting ran wide gained time significant",
        CornerCuttingRanWideGainedTimeExtreme = 29 => "Corner cutting ran wide gained time extreme",
        LapInvalidatedWallRiding = 30 => "Lap invalidated wall riding",
        LapInvalidatedFlashbackUsed = 31 => "Lap invalidated flashback used",
        LapInvalidatedResetToTrack = 32 => "Lap invalidated reset to track",
        BlockingThePitlane = 33 => "Blocking the pitlane",
        JumpStart = 34 => "Jump start",
        SafetyCarToCarCollision = 35 => "Safety car to car collision",
        SafetyCarIllegalOvertake = 36 => "Safety car illegal overtake",
        SafetyCarExceedingAllowedPace = 37 => "Safety car exceeding allowed pace",
        VirtualSafetyCarExceedingAllowedPace = 38 => "Virtual safety car exceeding allowed pace",
        FormationLapBelowAllowedSpeed = 39 => "Formation lap below allowed speed",
        FormationLapParking = 40 => "Formation lap parking",
        RetiredMechanicalFailure = 41 => "Retired mechanical failure",
        RetiredTerminallyDamaged = 42 => "Retired terminally damaged",
        SafetyCarFallingTooFarBack = 43 => "Safety car falling too far back",
        BlackFlagTimer = 44 => "Black flag timer",
        UnservedStopGoPenalty = 45 => "Unserved stop go penalty",
        UnservedDriveThroughPenalty = 46 => "Unserved drive through penalty",
        EngineComponentChange = 47 => "Engine component change",
        GearboxChange = 48 => "Gearbox change",
        ParcFermeChange = 49 => "Parc Fermé change",
        LeagueGridPenalty = 50 => "League grid penalty",
        RetryPenalty = 51 => "Retry penalty",
        IllegalTimeGain = 52 => "Illegal time gain",
        MandatoryPitstop = 53 => "Mandatory pitstop",
        AttributeAssigned = 54 => "Attribute assigned",
    }
}
