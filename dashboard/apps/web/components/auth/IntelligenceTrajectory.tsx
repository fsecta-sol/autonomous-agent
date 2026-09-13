/**
 * The login background: a single smooth asymmetric accelerating spline that
 * begins almost horizontal, holds a long runway, then progressively steepens
 * toward the far right and continues off-canvas. At the visible apex sits a
 * soft "intelligence horizon" glow — a tiny cyan core, a diffuse inner bloom,
 * and a wide faint fade, with no hard circular border or chart marker.
 *
 * The path is authored once in the SVG's own coordinate space and scaled by
 * preserveAspectRatio="none"; nothing here is absolutely positioned in pixels.
 */
export function IntelligenceTrajectory() {
  // shared geometry — three cubic segments, continuous at the joins
  const d = "M-180 900 C120 900 470 904 690 884 C815 872 900 820 970 700 C1035 600 1050 360 1068 70";
  return (
    <svg className="auth-growth-bg" viewBox="0 0 1440 960" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <filter id="auth-trail-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="12" />
        </filter>
        <filter id="auth-trail-soften" x="-15%" y="-15%" width="130%" height="130%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <radialGradient id="auth-terminal-glow">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="0.14" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path className="ag-haze" d={d} />
      <path className="ag-trail" d={d} />
      <path className="ag-core" d={d} />
      {/* terminal intelligence horizon — diffuse bloom, faint halo ring, tiny core */}
      <circle cx="1068" cy="70" r="44" fill="url(#auth-terminal-glow)" />
      <circle className="ag-node-diffusion" cx="1068" cy="70" r="18" />
      <circle className="ag-node-halo" cx="1068" cy="70" r="15" />
      <circle className="ag-node-core" cx="1068" cy="70" r="1.7" />
    </svg>
  );
}
