import type { Metadata } from "next";
import {
  IBM_Plex_Sans,
  IBM_Plex_Mono,
  IBM_Plex_Serif,
  Great_Vibes,
  Pinyon_Script,
  Cormorant_Garamond,
  Playfair_Display,
  EB_Garamond,
  Bodoni_Moda,
} from "next/font/google";
import { AuthProvider } from "@/components/providers/auth";
import { ThemeProvider } from "@/components/providers/theme";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// The display register: Plex Serif, the serif sibling of the Sans/Mono pair.
// Used only for the auth screens' evocative words — prose and UI stay sans, data stays mono.
const plexSerif = IBM_Plex_Serif({
  variable: "--font-plex-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

// The auth keywords cycle through this set — elegant scripts and high-contrast
// display serifs, never a casual hand. Six faces rotate on a fast loop, so the
// word keeps re-drawing itself in a new elegant register.
const vibes = Great_Vibes({ variable: "--font-vibes", subsets: ["latin"], weight: ["400"], display: "swap" });
const pinyon = Pinyon_Script({ variable: "--font-pinyon", subsets: ["latin"], weight: ["400"], display: "swap" });
const cormorant = Cormorant_Garamond({ variable: "--font-cormorant", subsets: ["latin"], weight: ["400", "600"], style: ["italic"], display: "swap" });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"], weight: ["400", "600"], style: ["italic"], display: "swap" });
const garamond = EB_Garamond({ variable: "--font-garamond", subsets: ["latin"], weight: ["400", "500"], style: ["italic"], display: "swap" });
const bodoni = Bodoni_Moda({ variable: "--font-bodoni", subsets: ["latin"], weight: ["400", "600"], style: ["italic"], display: "swap" });

const DISPLAY_VARS = [
  vibes.variable,
  pinyon.variable,
  cormorant.variable,
  playfair.variable,
  garamond.variable,
  bodoni.variable,
].join(" ");

export const metadata: Metadata = {
  title: "Swarm Command — autonomous AI research swarm",
  description:
    "The command layer for an autonomous research swarm. Observe agents, direct work, and keep every finding connected in a living knowledge graph.",
};

/** Applies the stored theme before first paint so there is no flash; with no stored
 *  preference it follows the OS, falling back to light if anything throws. */
const themeBoot = `(function(){try{var t=localStorage.getItem("agent-theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} ${plexSerif.variable} ${DISPLAY_VARS} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className="h-full">
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
