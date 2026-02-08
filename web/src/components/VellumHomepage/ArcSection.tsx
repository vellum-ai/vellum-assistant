import Image from "next/image";

export function ArcSection() {
  return (
    <div className="section_arc">
      <Image
        src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fed1d76b126d9f7a35bb_border%20arc.svg"
        loading="lazy"
        alt=""
        className="image-cover z-index-2 large-bg"
        width={0}
        height={0}
        unoptimized
      />
      <div className="image-cover ab-main w-embed">
        <style dangerouslySetInnerHTML={{__html: `
@keyframes arc-draw {
  from { stroke-dashoffset: 3000; }
  to { stroke-dashoffset: 0; }
}
@keyframes shimmer-move {
  from { transform: translateX(-40%); }
  to { transform: translateX(40%); }
}
.arc-draw {
  stroke-dasharray: 3000;
  stroke-dashoffset: 3000;
  animation: arc-draw 1.2s ease-out forwards;
}
.arc-shimmer {
  animation: shimmer-move 2.2s linear infinite;
  transform-origin: center;
}
`}} />
        <div style={{position: 'relative', height: '80px', overflow: 'hidden', background: '#fafafa'}}>
          <svg viewBox="0 0 1440 80" preserveAspectRatio="none" style={{position: 'absolute', bottom: 0, left: '-1px', width: 'calc(100% + 2px)', height: '100%'}}>
            <path d="M-10 80H1450V80C1450 80 1200 0 720 0C240 0 -10 80 -10 80Z" fill="#09090b" />
          </svg>
          <svg viewBox="0 0 1440 80" preserveAspectRatio="none" style={{position: 'absolute', bottom: 0, left: '-1px', width: 'calc(100% + 2px)', height: '100%'}}>
            <defs>
              <linearGradient id="arc-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgba(59,130,246,0.3)" />
                <stop offset="20%" stopColor="rgba(99,102,241,1)" />
                <stop offset="40%" stopColor="rgba(139,92,246,1)" />
                <stop offset="60%" stopColor="rgba(168,85,247,1)" />
                <stop offset="80%" stopColor="rgba(99,102,241,1)" />
                <stop offset="100%" stopColor="rgba(59,130,246,0.3)" />
              </linearGradient>
              <linearGradient id="arc-shimmer" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgba(255,255,255,0)" />
                <stop offset="50%" stopColor="rgba(255,255,255,0.6)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
              <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="14" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <path className="arc-draw" d="M-10 80C-10 80 240 0 720 0C1200 0 1450 80 1450 80" fill="none" stroke="url(#arc-gradient)" strokeWidth="6" filter="url(#glow)" opacity="0.7" />
            <path className="arc-draw" d="M-10 80C-10 80 240 0 720 0C1200 0 1450 80 1450 80" fill="none" stroke="url(#arc-gradient)" strokeWidth="2" />
            <path className="arc-shimmer" d="M-10 80C-10 80 240 0 720 0C1200 0 1450 80 1450 80" fill="none" stroke="url(#arc-shimmer)" strokeWidth="2" opacity="0.9" />
          </svg>
        </div>
      </div>
    </div>
  );
}
