'use client';

// ─── KarlSpinner ─────────────────────────────────────────────────────────────
// Reusable animated KO reticle spinner.
// Usage: <KarlSpinner size="md" color="#14b8a6" />

interface KarlSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  color?: string;
}

const SIZE_MAP = {
  sm: { outer: 48, rings: [21, 13, 6],  logo: 14, stroke: 1.5 },
  md: { outer: 72, rings: [32, 20, 9],  logo: 22, stroke: 2   },
  lg: { outer: 108, rings: [48, 30, 14], logo: 34, stroke: 2.5 },
};

const DASH_MAP = {
  sm: { outer: [33, 99],  mid: [20, 61],  inner: [9,  28]  },
  md: { outer: [50, 150], mid: [31, 94],  inner: [14, 42]  },
  lg: { outer: [75, 226], mid: [47, 141], inner: [22, 66]  },
};

export default function KarlSpinner({ size = 'md', color = '#14b8a6' }: KarlSpinnerProps) {
  const s   = SIZE_MAP[size];
  const d   = DASH_MAP[size];
  const dim = s.outer;
  const cx  = dim / 2;

  const ringStyle = (animation: string): React.CSSProperties => ({
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    animation,
  });

  return (
    <div style={{ position: 'relative', width: dim, height: dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>

      {/* Outer ring — slowest */}
      <svg style={ringStyle('ko-spin-outer 2.4s linear infinite')} width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`}>
        <style>{`
          @keyframes ko-spin-outer  { from { transform: translate(-50%,-50%) rotate(0deg); }   to { transform: translate(-50%,-50%) rotate(360deg); } }
          @keyframes ko-spin-mid    { from { transform: translate(-50%,-50%) rotate(0deg); }   to { transform: translate(-50%,-50%) rotate(240deg); } }
          @keyframes ko-spin-inner  { from { transform: translate(-50%,-50%) rotate(0deg); }   to { transform: translate(-50%,-50%) rotate(-360deg); } }
          @keyframes ko-logo-spin   { from { transform: rotate(0deg); }                        to { transform: rotate(360deg); } }
        `}</style>
        <circle cx={cx} cy={cx} r={s.rings[0]} fill="none" stroke={color} strokeWidth={s.stroke}
          strokeDasharray={`${d.outer[0]} ${d.outer[1]}`} strokeLinecap="round" />
      </svg>

      {/* Mid ring */}
      <svg style={ringStyle('ko-spin-mid 1.8s linear infinite')} width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`}>
        <circle cx={cx} cy={cx} r={s.rings[1]} fill="none" stroke={color} strokeWidth={s.stroke}
          strokeDasharray={`${d.mid[0]} ${d.mid[1]}`} strokeLinecap="round" opacity={0.7} />
      </svg>

      {/* Inner ring — fastest */}
      <svg style={ringStyle('ko-spin-inner 1.2s linear infinite')} width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`}>
        <circle cx={cx} cy={cx} r={s.rings[2]} fill="none" stroke={color} strokeWidth={s.stroke}
          strokeDasharray={`${d.inner[0]} ${d.inner[1]}`} strokeLinecap="round" opacity={0.45} />
      </svg>

      {/* KO reticle center — slowest of all */}
      <div style={{ position: 'relative', zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'ko-logo-spin 6s linear infinite' }}>
        <svg width={s.logo} height={s.logo} viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="14" stroke={color} strokeWidth="2.5" />
          <circle cx="16" cy="16" r="6"  stroke={color} strokeWidth="2" />
          <circle cx="16" cy="16" r="1.5" fill={color} />
          <line x1="16" y1="2"  x2="16" y2="8"  stroke={color} strokeWidth="2" strokeLinecap="round" />
          <line x1="16" y1="24" x2="16" y2="30" stroke={color} strokeWidth="2" strokeLinecap="round" />
          <line x1="2"  y1="16" x2="8"  y2="16" stroke={color} strokeWidth="2" strokeLinecap="round" />
          <line x1="24" y1="16" x2="30" y2="16" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>

    </div>
  );
}
