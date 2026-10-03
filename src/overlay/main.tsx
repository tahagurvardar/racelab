import { createRoot } from "react-dom/client";
import Overlay from "./Overlay";
import "../styles/fonts.css";
import "../styles/tokens.css";
import "./overlay.css";

createRoot(document.getElementById("root")!).render(<Overlay />);
