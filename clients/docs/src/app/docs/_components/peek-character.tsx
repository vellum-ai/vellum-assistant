"use client";

import { useEffect, useRef, useState } from "react";

// The docs TOC peek character: the teal, curious-eyed urchin that pops up
// from the bottom of the viewport under the community speech bubble.
//
// The SVG path data and the body/eye transform math mirror the assistant's
// avatar pipeline (assistant/src/avatar/character-components.ts and
// svg-compositor.ts) so this character renders identically to the same
// urchin composed by the daemon. Keep them in sync if the catalog changes.

const URCHIN_BODY = {
  viewBox: { width: 794, height: 720 },
  faceCenter: { x: 397, y: 338 },
  svgPath:
    "M294.515 186.33C290.926 182.311 287.411 178.223 283.736 174.285C255.181 143.686 237.726 106.858 224.624 67.7708C221.922 59.7082 221.014 50.6841 221.11 42.1235C221.295 25.7049 233.064 17.8357 248.541 23.4619C254.559 25.65 260.702 28.8342 265.378 33.1064C277.385 44.0774 289.777 54.9774 299.853 67.626C313.811 85.1474 325.792 104.243 338.617 122.665C340.383 125.204 342.137 127.751 345.66 129.793C345.259 121.324 344.546 112.855 344.526 104.384C344.49 88.8345 344.241 73.2395 345.329 57.7508C345.875 49.9765 348.303 42.0299 351.376 34.7965C359.52 15.637 376.269 13.3068 389.644 29.0276C397.8 38.6138 402.618 49.9948 405.881 61.9238C414.873 94.7912 421.728 128.112 426.003 161.94C426.402 165.096 426.969 168.231 429.108 171.932C430.344 169.342 431.737 166.813 432.795 164.152C451.865 116.184 478.991 73.1319 513.081 34.5321C520.917 25.6599 530.426 18.0812 539.948 10.9498C545.615 6.70501 552.535 3.58415 559.368 1.54792C576.16 -3.45791 588.665 3.8339 591.208 21.1556C593.08 33.9082 593.763 47.2524 592.171 59.9825C590.435 73.8528 586.186 87.5585 581.754 100.913C571.342 132.286 557.635 162.224 540.214 190.399C537.626 194.586 535.262 198.911 534.128 204.328C536.972 202.423 539.852 200.569 542.653 198.603C556.596 188.816 570.47 178.93 584.456 169.206C614.283 148.469 647.654 135.529 682.263 125.54C688.765 123.664 695.867 122.972 702.652 123.159C713.904 123.468 720.214 131.503 717.203 142.284C715.307 149.074 711.569 155.622 707.514 161.49C692.518 183.186 673.201 200.825 652.363 216.643C632.461 231.751 611.755 245.804 591.386 260.296C588.209 262.556 584.938 264.685 579.709 268.231C584.517 268.511 587.145 268.847 589.763 268.789C638.566 267.692 686.823 271.965 734.215 283.994C744.006 286.479 753.628 289.901 763.003 293.691C773.991 298.134 782.9 305.511 789.297 315.65C796.827 327.584 794.162 339.013 780.931 343.895C768.816 348.366 755.947 351.686 743.136 353.225C697.592 358.692 651.905 362.624 605.642 359.936C616.683 365.218 628.128 369.808 638.676 375.938C656.819 386.481 674.627 397.645 692.132 409.218C701.774 415.593 708.433 424.652 709.643 436.758C710.806 448.401 706.534 455.432 695.6 459.516C683.268 464.122 670.45 463.849 658.061 460.912C633.414 455.067 609.006 448.207 584.503 441.756C581.859 441.06 579.232 440.292 575.916 440.921C577.782 442.502 579.632 444.103 581.517 445.661C625.821 482.299 661.92 526.023 692.447 574.478C703.179 591.515 711.331 609.609 710.856 630.425C710.806 632.594 710.83 634.799 710.448 636.922C708.794 646.103 703.379 650.57 694.271 648.581C687.312 647.062 680.063 644.656 674.209 640.751C661.29 632.132 648.094 623.442 636.936 612.772C608.662 585.734 581.451 557.588 553.806 529.894C552.398 528.484 550.912 527.151 548.249 526.695C549.791 529.363 551.316 532.041 552.879 534.696C564.449 554.362 576.277 573.883 587.466 593.761C591.333 600.629 593.903 608.288 596.504 615.78C597.654 619.095 597.931 622.93 597.697 626.468C596.89 638.652 586.543 645.379 575.396 640.478C569.882 638.052 564.364 634.52 560.292 630.145C548.216 617.175 536.37 603.925 525.369 590.045C515.984 578.203 507.893 565.337 497.773 550.836C499.144 558.95 500.763 564.696 500.928 570.484C501.132 577.632 500.995 585.009 499.441 591.937C497.166 602.077 489.704 606.78 479.3 606.192C468.49 605.581 459.903 600.394 453.083 592.425C447.716 586.152 443.012 579.31 436.928 571.292C439.639 583.059 442.231 593.118 444.248 603.291C450.143 633.03 452.019 662.882 445.684 692.825C444.713 697.412 443.768 702.116 441.936 706.391C435.711 720.911 419.931 724.247 409.762 712.438C403.763 705.472 398.366 697.025 395.716 688.326C388.341 664.118 382.261 639.5 376.215 614.91C371.808 596.988 368.287 578.849 364.313 560.82C363.802 558.502 362.939 556.263 361.617 551.965C358.827 563.829 356.929 573.777 354.095 583.451C350.846 594.54 347.203 605.56 342.916 616.285C339.101 625.826 332.805 633.939 324.393 640.001C320.63 642.712 316.39 645.463 311.977 646.437C300.425 648.986 289.18 648.873 285.976 630.411C283.695 617.265 284.637 604.377 287.788 591.644C290.829 579.356 294.597 567.247 298.062 555.064C299.02 551.695 300.034 548.343 299.688 544.273C297.649 546.644 295.517 548.941 293.585 551.396C272.752 577.88 252.398 604.758 230.922 630.709C222.242 641.199 211.213 649.768 201.069 659.01C198.7 661.168 195.692 662.712 192.802 664.197C174.923 673.382 159.519 665.931 157.113 646.008C156.238 638.763 157.516 630.646 160.044 623.743C164.127 612.587 169.264 601.634 175.359 591.432C191.703 564.078 208.785 537.164 225.591 510.085C228.038 506.141 230.576 502.251 234.473 496.139C229.868 497.617 227.611 498.065 225.606 499.033C215.819 503.758 206.205 508.851 196.328 513.372C185.72 518.229 174.679 522.015 162.775 521.008C157.806 520.588 152.645 519.611 148.091 517.669C136.302 512.644 132.798 504.611 136.535 492.221C141.872 474.519 154.213 461.746 167.266 449.555C169.332 447.625 171.754 446.076 173.616 442.991C171.443 443.292 169.194 443.33 167.108 443.931C123.775 456.421 79.5185 459.784 34.6988 457.123C27.8868 456.718 20.9129 455.747 14.4336 453.706C0.908617 449.448 -3.50076 437.976 2.86467 425.249C6.70643 417.569 12.4396 411.581 20.2111 407.848C58.9649 389.23 98.9102 374.491 142.201 370.713C145.72 370.406 149.196 369.605 154.097 368.804C141.101 362.29 129.493 356.68 118.105 350.657C113.666 348.309 109.162 345.582 105.661 342.062C96.3634 332.713 98.382 319.883 110.258 314.244C116.706 311.183 123.841 308.878 130.896 307.92C145.554 305.93 160.366 305.065 175.791 303.676C173.747 302.193 171.727 300.55 169.543 299.169C150.261 286.972 130.969 274.793 111.642 262.669C98.6204 254.501 87.584 244.099 77.2847 232.8C68.5257 223.19 63.0141 211.886 59.6886 199.489C56.5094 187.638 61.3928 178.296 73.2079 175.124C88.4997 171.017 103.758 170.524 119.024 176.674C145.875 187.492 169.54 203.31 192.386 220.761C203.581 229.313 215.7 236.661 227.461 244.465C229.174 245.602 231.22 246.238 234.26 246.038C232.877 244.372 231.626 242.573 230.091 241.06C219.764 230.882 209.334 220.808 199.02 210.615C186.946 198.683 178.095 184.691 173.135 168.435C169.997 158.149 167.91 147.579 176.983 138.998C186.671 129.836 198.24 128.596 210.367 133.148C233.319 141.765 254.195 153.89 272.275 170.631C278.845 176.715 285.699 182.491 292.423 188.407C293.118 187.714 293.817 187.022 294.515 186.33Z",
};

const SCLERA = "#F2F2F2";
const PUPIL = "#1A1A1A";

const CURIOUS_EYES = {
  sourceViewBox: { width: 613, height: 628 },
  eyeCenter: { x: 264, y: 415 },
  paths: [
    {
      svgPath:
        "M219.737 414.847C219.737 420.414 219.404 425.84 218.785 431.075C218.785 431.075 218.832 431.122 218.785 431.169C215.264 460.388 202.463 483.801 185.902 492.081C181.667 494.175 177.241 495.318 172.625 495.318C146.642 495.318 125.514 459.294 125.514 414.847C125.514 370.447 146.643 334.425 172.625 334.425C198.656 334.424 219.737 370.447 219.737 414.847Z",
      color: SCLERA,
    },
    {
      svgPath:
        "M218.785 431.075C218.785 431.075 218.832 431.121 218.785 431.169C215.264 460.388 202.463 483.8 185.902 492.081C176.433 484.848 169.723 466.384 169.723 444.78C169.723 416.845 180.905 394.241 194.754 394.241C206.223 394.241 215.835 409.802 218.785 431.075Z",
      color: PUPIL,
    },
    {
      svgPath:
        "M308.084 414.847C308.084 420.414 308.416 425.84 309.036 431.075C309.036 431.075 308.988 431.122 309.036 431.169C312.557 460.388 325.358 483.801 341.918 492.081C346.154 494.175 350.58 495.318 355.196 495.318C381.179 495.318 402.307 459.294 402.307 414.847C402.307 370.447 381.178 334.425 355.196 334.425C329.165 334.424 308.084 370.447 308.084 414.847Z",
      color: SCLERA,
    },
    {
      svgPath:
        "M309.037 431.075C309.037 431.075 308.989 431.121 309.037 431.169C312.558 460.388 325.359 483.8 341.919 492.081C351.389 484.848 358.099 466.384 358.099 444.78C358.099 416.845 346.916 394.241 333.068 394.241C321.599 394.241 311.987 409.802 309.037 431.075Z",
      color: PUPIL,
    },
  ],
};

const TEAL = "#0E9B8B";

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// SSR renders the motion-on path (false), then syncs to the media query on
// mount so the blink/twitch timers never schedule for motion-sensitive
// readers. The CSS breathe pulse is gated separately via a media query.
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduce(mq.matches);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

// Body transform: aspect-fit scale + center translation from the body viewBox
// to the output size. Eye transform: remap from the eye sourceViewBox into the
// body viewBox (aligning eyeCenter onto the body's faceCenter), composed with
// the body-to-output transform.
function computeLayout(size: number) {
  const bodyVB = URCHIN_BODY.viewBox;
  const bodyScale = Math.min(size / bodyVB.width, size / bodyVB.height);
  const bodyTx = (size - bodyVB.width * bodyScale) / 2;
  const bodyTy = (size - bodyVB.height * bodyScale) / 2;

  const eyeVB = CURIOUS_EYES.sourceViewBox;
  const remapScale = Math.min(bodyVB.width / eyeVB.width, bodyVB.height / eyeVB.height);
  const remapTx = URCHIN_BODY.faceCenter.x - CURIOUS_EYES.eyeCenter.x * remapScale;
  const remapTy = URCHIN_BODY.faceCenter.y - CURIOUS_EYES.eyeCenter.y * remapScale;

  const composedScale = bodyScale * remapScale;
  const composedTx = bodyScale * remapTx + bodyTx;
  const composedTy = bodyScale * remapTy + bodyTy;

  return {
    bodyTransform: `matrix(${bodyScale},0,0,${bodyScale},${bodyTx},${bodyTy})`,
    eyeTransform: `matrix(${composedScale},0,0,${composedScale},${composedTx},${composedTy})`,
    eyeCenterX: bodyScale * (remapTx + CURIOUS_EYES.eyeCenter.x * remapScale) + bodyTx,
    eyeCenterY: bodyScale * (remapTy + CURIOUS_EYES.eyeCenter.y * remapScale) + bodyTy,
  };
}

/**
 * The teal curious urchin, with the avatar family's idle animations:
 *   - Breathing: continuous 4s scale pulse (CSS keyframe)
 *   - Blink: random eye scaleY squish with a quick first "hello" wink after
 *     mount, 20% double-blink
 *   - Twitch: random 8-15s body rotation wobble (±1-2°)
 *
 * All animations are suppressed under `prefers-reduced-motion: reduce`.
 */
export function PeekCharacter({ size }: { size: number }) {
  const [isBlinking, setIsBlinking] = useState(false);
  const [twitchAngle, setTwitchAngle] = useState(0);
  const mountedRef = useRef(true);
  const reduceMotion = usePrefersReducedMotion();

  const { bodyTransform, eyeTransform, eyeCenterX, eyeCenterY } = computeLayout(size);

  useEffect(() => {
    if (reduceMotion) {
      return;
    }
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    function scheduleBlink(isFirst = false) {
      const [minDelay, maxDelay] = isFirst ? [400, 1200] : [3000, 7000];
      timer = setTimeout(() => {
        if (!mountedRef.current) {return;}
        setIsBlinking(true);
        timer = setTimeout(() => {
          if (!mountedRef.current) {return;}
          setIsBlinking(false);
          if (Math.random() < 0.2) {
            timer = setTimeout(() => {
              if (!mountedRef.current) {return;}
              setIsBlinking(true);
              timer = setTimeout(() => {
                if (!mountedRef.current) {return;}
                setIsBlinking(false);
                scheduleBlink();
              }, 150);
            }, 200);
          } else {
            scheduleBlink();
          }
        }, 150);
      }, randomBetween(minDelay, maxDelay));
    }

    scheduleBlink(true);
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      setIsBlinking(false);
    };
  }, [reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      return;
    }
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    function scheduleTwitch() {
      timer = setTimeout(() => {
        if (!mountedRef.current) {return;}
        setTwitchAngle((Math.random() < 0.5 ? -1 : 1) * randomBetween(1, 2));
        timer = setTimeout(() => {
          if (!mountedRef.current) {return;}
          setTwitchAngle(0);
          scheduleTwitch();
        }, 200);
      }, randomBetween(8000, 15000));
    }

    scheduleTwitch();
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      setTwitchAngle(0);
    };
  }, [reduceMotion]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="docs-peek-character"
      style={{
        transformOrigin: "center",
        // The body reaches the viewBox edges, so the idle twitch rotation
        // draws past them and would otherwise be clipped flat.
        overflow: "visible",
      }}
    >
      <g
        style={{
          transform: `rotate(${twitchAngle}deg)`,
          transformOrigin: `${size / 2}px ${size / 2}px`,
          transition: reduceMotion
            ? "none"
            : twitchAngle !== 0
              ? "transform 0.2s ease-in-out"
              : "transform 0.3s ease-out",
        }}
      >
        <path d={URCHIN_BODY.svgPath} fill={TEAL} transform={bodyTransform} />
      </g>
      <g
        style={{
          transform: isBlinking ? "scaleY(0.1)" : "scaleY(1)",
          transformOrigin: `${eyeCenterX}px ${eyeCenterY}px`,
          transition: reduceMotion ? "none" : "transform 0.15s ease-in-out",
        }}
      >
        {CURIOUS_EYES.paths.map((p, i) => (
          <path key={i} d={p.svgPath} fill={p.color} transform={eyeTransform} />
        ))}
      </g>
      <style>{`
        @keyframes docs-peek-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.03); }
        }
        @media (prefers-reduced-motion: no-preference) {
          .docs-peek-character {
            animation: docs-peek-breathe 4s ease-in-out infinite;
          }
        }
      `}</style>
    </svg>
  );
}
