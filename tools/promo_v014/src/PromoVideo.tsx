import type {CSSProperties, ReactNode} from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import captureManifest from "./capture-manifest.json";
import script from "./script.zh-CN.json";

const FPS = 30;
const DURATION_SECONDS = 72;
const WIDTH = 1920;
const HEIGHT = 1080;
const FONT = '"Microsoft YaHei UI", "Noto Sans SC", "Segoe UI", sans-serif';
const ACCENT = "#7c8cff";
const ACCENT_2 = "#5b6cff";

type Clip = (typeof captureManifest.clips)[number];

const clip = (name: string): Clip => {
  const found = captureManifest.clips.find((item) => item.name === name);
  if (!found) throw new Error(`Missing capture clip: ${name}`);
  return found;
};

const fade = (frame: number, duration: number, edge = 14) =>
  interpolate(frame, [0, edge, duration - edge, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const Background = () => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 75) * 40;
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 15% 18%, rgba(124,140,255,.20), transparent 32%), radial-gradient(circle at 85% 76%, rgba(68,206,190,.12), transparent 34%), linear-gradient(145deg, #070914 0%, #0d1020 46%, #080a13 100%)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -120,
          opacity: 0.26,
          transform: `translate(${drift}px, ${-drift * 0.35}px)`,
          backgroundImage:
            "linear-gradient(rgba(156,164,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(156,164,255,.08) 1px, transparent 1px)",
          backgroundSize: "58px 58px",
          maskImage: "radial-gradient(circle at center, black 0%, transparent 72%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 620,
          height: 620,
          borderRadius: "50%",
          left: -220 + drift,
          top: -250,
          background: "rgba(91,108,255,.16)",
          filter: "blur(110px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 520,
          height: 520,
          borderRadius: "50%",
          right: -160 - drift,
          bottom: -210,
          background: "rgba(65,188,177,.10)",
          filter: "blur(120px)",
        }}
      />
    </AbsoluteFill>
  );
};

const Logo = ({size = 52}: {size?: number}) => (
  <Img src={staticFile("logo.svg")} style={{width: size, height: size, borderRadius: size * 0.25}} />
);

const BrandBug = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [260, 290], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 50,
        top: 36,
        display: "flex",
        alignItems: "center",
        gap: 14,
        color: "#f2f4ff",
        fontFamily: FONT,
        fontWeight: 700,
        fontSize: 24,
        opacity,
        zIndex: 30,
        textShadow: "0 2px 18px rgba(0,0,0,.55)",
      }}
    >
      <Logo size={38} />
      Little Alphaxiv
      <span style={{fontSize: 14, color: "#b8c0e8", fontWeight: 600}}>v0.1.4</span>
    </div>
  );
};

const FragmentCard = ({
  label,
  icon,
  x,
  y,
  rotate,
  delay,
}: {
  label: string;
  icon: string;
  x: number;
  y: number;
  rotate: number;
  delay: number;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame: frame - delay, fps, config: {damping: 15, stiffness: 110}});
  const converge = interpolate(frame, [95, 145], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const left = interpolate(converge, [0, 1], [x, 760]);
  const top = interpolate(converge, [0, 1], [y, 470]);
  const scale = interpolate(converge, [0, 1], [enter, 0.74]);
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: 400,
        height: 220,
        borderRadius: 28,
        border: "1px solid rgba(173,181,255,.28)",
        background: "linear-gradient(145deg, rgba(28,32,55,.92), rgba(14,17,31,.90))",
        boxShadow: "0 28px 80px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06)",
        color: "#eef0ff",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 22,
        transform: `rotate(${rotate * (1 - converge)}deg) scale(${scale})`,
        opacity: enter,
      }}
    >
      <div style={{fontSize: 62}}>{icon}</div>
      <div style={{fontSize: 25, fontWeight: 800, letterSpacing: 3}}>{label}</div>
    </div>
  );
};

const Hook = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [12, 28, 92, 112], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{fontFamily: FONT}}>
      <FragmentCard label="搜索" icon="⌕" x={190} y={460} rotate={-7} delay={4} />
      <FragmentCard label="PDF" icon="▤" x={760} y={505} rotate={2} delay={10} />
      <FragmentCard label="AI 对话" icon="✦" x={1320} y={445} rotate={7} delay={16} />
      <div
        style={{
          position: "absolute",
          top: 160,
          width: "100%",
          textAlign: "center",
          color: "#f5f6ff",
          fontSize: 58,
          lineHeight: 1.3,
          fontWeight: 850,
          letterSpacing: -1,
          opacity: titleOpacity,
        }}
      >
        找论文、读 PDF、问 AI
        <div style={{fontSize: 29, marginTop: 15, color: "#b7bedf", fontWeight: 600, letterSpacing: 1}}>
          不该在三个工具之间来回切换
        </div>
      </div>
    </AbsoluteFill>
  );
};

const ProductReveal = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logoScale = spring({frame, fps, config: {damping: 14, stiffness: 100}});
  const line = interpolate(frame, [25, 46], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const uiOpacity = interpolate(frame, [95, 135, 195], [0, 1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{fontFamily: FONT, alignItems: "center", justifyContent: "center"}}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          transform: `translateY(${interpolate(uiOpacity, [0, 1], [0, -210])}px) scale(${logoScale})`,
        }}
      >
        <Logo size={96} />
        <div>
          <div style={{fontSize: 66, color: "#f3f5ff", fontWeight: 850, letterSpacing: -2}}>Little Alphaxiv</div>
          <div style={{fontSize: 25, color: "#b8c0e8", marginTop: 8, opacity: line}}>发现 · 阅读 · 讨论，一个工作区</div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 195,
          right: 195,
          bottom: 80,
          height: 495,
          borderRadius: 28,
          overflow: "hidden",
          border: "1px solid rgba(157,166,255,.28)",
          boxShadow: "0 34px 90px rgba(0,0,0,.5)",
          opacity: uiOpacity,
          transform: `translateY(${interpolate(uiOpacity, [0, 1], [55, 0])}px)`,
        }}
      >
        <OffthreadVideo
          src={staticFile(clip("search").file)}
          startFrom={Math.round(clip("search").trimStartSeconds * FPS)}
          muted
          style={{width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 27%"}}
        />
      </div>
    </AbsoluteFill>
  );
};

const BrowserChrome = ({children}: {children: ReactNode}) => (
  <div
    style={{
      position: "absolute",
      left: 112,
      right: 112,
      top: 86,
      bottom: 78,
      borderRadius: 28,
      overflow: "hidden",
      background: "#0b0e19",
      border: "1px solid rgba(158,167,255,.30)",
      boxShadow: "0 38px 100px rgba(0,0,0,.56), 0 0 0 1px rgba(255,255,255,.025) inset",
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: 42,
        background: "linear-gradient(180deg, rgba(30,34,54,.97), rgba(20,23,39,.97))",
        borderBottom: "1px solid rgba(158,167,255,.12)",
        zIndex: 4,
        display: "flex",
        alignItems: "center",
        gap: 9,
        paddingLeft: 18,
      }}
    >
      {["#ff6b7a", "#f5be56", "#5bd49a"].map((color) => (
        <span key={color} style={{width: 11, height: 11, borderRadius: "50%", background: color, opacity: 0.86}} />
      ))}
      <div
        style={{
          marginLeft: 16,
          width: 340,
          height: 22,
          borderRadius: 7,
          color: "#939bc2",
          background: "rgba(6,8,17,.62)",
          fontFamily: FONT,
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          paddingLeft: 14,
        }}
      >
        127.0.0.1 · Little Alphaxiv
      </div>
    </div>
    <div style={{position: "absolute", inset: "42px 0 0 0", overflow: "hidden"}}>{children}</div>
  </div>
);

const Callout = ({eyebrow, title}: {eyebrow: string; title: string}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame: frame - 7, fps, config: {damping: 15, stiffness: 105}});
  return (
    <div
      style={{
        position: "absolute",
        left: 148,
        top: 115,
        zIndex: 12,
        fontFamily: FONT,
        color: "white",
        transform: `translateY(${interpolate(enter, [0, 1], [28, 0])}px)`,
        opacity: enter,
        padding: "16px 22px 18px",
        borderRadius: 16,
        background: "linear-gradient(135deg, rgba(12,15,28,.94), rgba(23,27,49,.86))",
        border: "1px solid rgba(156,166,255,.26)",
        boxShadow: "0 14px 45px rgba(0,0,0,.4)",
      }}
    >
      <div style={{fontSize: 13, color: "#aeb7e4", fontWeight: 800, letterSpacing: 2.2}}>{eyebrow}</div>
      <div style={{fontSize: 29, fontWeight: 850, marginTop: 6}}>{title}</div>
    </div>
  );
};

const BrowserScene = ({
  name,
  durationFrames,
  eyebrow,
  title,
  scale = 1,
  translateX = 0,
  translateY = 0,
}: {
  name: string;
  durationFrames: number;
  eyebrow: string;
  title: string;
  scale?: number;
  translateX?: number;
  translateY?: number;
}) => {
  const frame = useCurrentFrame();
  const item = clip(name);
  const sceneSeconds = durationFrames / FPS;
  const playbackRate = item.usableDurationSeconds / sceneSeconds;
  const sceneOpacity = fade(frame, durationFrames, 13);
  const driftScale = interpolate(frame, [0, durationFrames], [scale * 0.985, scale], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{opacity: sceneOpacity}}>
      <BrowserChrome>
        <OffthreadVideo
          src={staticFile(item.file)}
          startFrom={Math.round(item.trimStartSeconds * FPS)}
          playbackRate={playbackRate}
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `translate(${translateX}px, ${translateY}px) scale(${driftScale})`,
          }}
        />
      </BrowserChrome>
      <Callout eyebrow={eyebrow} title={title} />
    </AbsoluteFill>
  );
};

const CaptionLayer = () => {
  const frame = useCurrentFrame();
  const segments = script.segments;
  const activeIndex = segments.findIndex((segment, index) => {
    const next = segments[index + 1];
    return frame >= segment.start * FPS && frame < (next ? next.start : script.durationSeconds) * FPS;
  });
  if (activeIndex < 0) return null;
  const segment = segments[activeIndex];
  const local = frame - segment.start * FPS;
  const duration = ((segments[activeIndex + 1]?.start ?? script.durationSeconds) - segment.start) * FPS;
  const opacity = fade(local, duration, 8);
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: 31,
        transform: "translateX(-50%)",
        zIndex: 40,
        color: "#f6f7ff",
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: 25,
        letterSpacing: 0.4,
        whiteSpace: "nowrap",
        padding: "13px 25px 14px",
        borderRadius: 999,
        background: "rgba(7,9,18,.78)",
        border: "1px solid rgba(165,174,255,.30)",
        boxShadow: "0 12px 34px rgba(0,0,0,.40)",
        backdropFilter: "blur(14px)",
        opacity,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: ACCENT,
          marginRight: 13,
          boxShadow: `0 0 16px ${ACCENT}`,
        }}
      />
      {segment.caption}
    </div>
  );
};

const TrustScene = () => {
  const frame = useCurrentFrame();
  const features = [
    ["⌂", "自托管", "Docker / source install"],
    ["◫", "服务端持久化", "聊天、批注与设置留在自己的服务器"],
    ["◇", "API key 加密", "浏览器只看到掩码预览"],
  ];
  return (
    <AbsoluteFill style={{fontFamily: FONT, justifyContent: "center", alignItems: "center"}}>
      <div style={{fontSize: 19, color: "#98a3d1", fontWeight: 800, letterSpacing: 4, marginBottom: 24}}>YOUR RESEARCH · YOUR SERVER</div>
      <div style={{fontSize: 48, color: "#f4f6ff", fontWeight: 850, marginBottom: 50}}>把控制权留在自己手里</div>
      <div style={{display: "flex", gap: 28}}>
        {features.map(([icon, title, detail], index) => {
          const enter = spring({frame: frame - 10 - index * 7, fps: FPS, config: {damping: 16, stiffness: 100}});
          return (
            <div
              key={title}
              style={{
                width: 440,
                height: 215,
                padding: "30px 32px",
                borderRadius: 24,
                background: "linear-gradient(145deg, rgba(26,30,51,.92), rgba(13,16,29,.92))",
                border: "1px solid rgba(156,165,255,.23)",
                boxShadow: "0 22px 70px rgba(0,0,0,.35)",
                color: "white",
                opacity: enter,
                transform: `translateY(${interpolate(enter, [0, 1], [36, 0])}px)`,
              }}
            >
              <div style={{fontSize: 39, color: ACCENT, marginBottom: 20}}>{icon}</div>
              <div style={{fontSize: 27, fontWeight: 850}}>{title}</div>
              <div style={{fontSize: 17, color: "#aeb6d8", marginTop: 13, lineHeight: 1.55}}>{detail}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const EndCard = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, config: {damping: 15, stiffness: 92}});
  const lineWidth = interpolate(frame, [16, 66], [0, 560], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{fontFamily: FONT, alignItems: "center", justifyContent: "center"}}>
      <div style={{display: "flex", alignItems: "center", gap: 26, transform: `scale(${enter})`}}>
        <Logo size={94} />
        <div style={{fontSize: 62, color: "#f4f6ff", fontWeight: 880, letterSpacing: -2}}>Little Alphaxiv</div>
      </div>
      <div style={{width: lineWidth, height: 3, borderRadius: 999, background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT_2})`, marginTop: 30}} />
      <div style={{fontSize: 30, color: "#c3c9e8", fontWeight: 650, marginTop: 30}}>让读论文真正连贯起来</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 48,
          borderRadius: 999,
          padding: "14px 24px",
          color: "#eef0ff",
          background: "rgba(124,140,255,.13)",
          border: "1px solid rgba(124,140,255,.32)",
          fontSize: 18,
        }}
      >
        <span style={{fontWeight: 850}}>v0.1.4</span>
        <span style={{color: "#7f88ae"}}>·</span>
        <span>github.com/DylanUnicorn/little-alphaxiv</span>
      </div>
    </AbsoluteFill>
  );
};

const AudioTrack = () => (
  <>
    <Audio src={staticFile("generated/ambient-bed.wav")} volume={0.58} />
    {script.segments.map((segment) => (
      <Sequence key={segment.id} from={Math.round(segment.start * FPS)}>
        <Audio src={staticFile(`generated/voice-${segment.id}.mp3`)} volume={1} />
      </Sequence>
    ))}
  </>
);

export const PromoVideo = () => {
  const searchStart = 12 * FPS;
  const askStart = 22 * FPS;
  const branchStart = 35 * FPS;
  const appearanceStart = 47 * FPS;
  const providerStart = 55 * FPS;
  const trustStart = Math.round(62.5 * FPS);
  const endStart = Math.round(68.2 * FPS);
  return (
    <AbsoluteFill style={{background: "#080a13"}}>
      <Background />
      <Sequence from={0} durationInFrames={5 * FPS}>
        <Hook />
      </Sequence>
      <Sequence from={5 * FPS} durationInFrames={7 * FPS}>
        <ProductReveal />
      </Sequence>
      <Sequence from={searchStart} durationInFrames={10 * FPS}>
        <BrowserScene
          name="search"
          durationFrames={10 * FPS}
          eyebrow="PAPER DISCOVERY"
          title="从问题出发，搜索过程透明可见"
          scale={1.025}
        />
      </Sequence>
      <Sequence from={askStart} durationInFrames={13 * FPS}>
        <BrowserScene
          name="ask-ai"
          durationFrames={13 * FPS}
          eyebrow="GROUNDED READING"
          title="选中原文，带着页码继续追问"
          scale={1.055}
          translateX={-8}
        />
      </Sequence>
      <Sequence from={branchStart} durationInFrames={12 * FPS}>
        <BrowserScene
          name="branch"
          durationFrames={12 * FPS}
          eyebrow="BRANCHING PAPER CHATS"
          title="保留主线，探索另一条推理路径"
          scale={1.07}
          translateX={-18}
        />
      </Sequence>
      <Sequence from={appearanceStart} durationInFrames={8 * FPS}>
        <BrowserScene
          name="appearance"
          durationFrames={8 * FPS}
          eyebrow="READING COMFORT"
          title="主题、排版与公式显示，按你的习惯调整"
          scale={1.08}
          translateX={24}
          translateY={18}
        />
      </Sequence>
      <Sequence from={providerStart} durationInFrames={Math.round(7.5 * FPS)}>
        <BrowserScene
          name="provider"
          durationFrames={Math.round(7.5 * FPS)}
          eyebrow="BRING YOUR OWN MODEL"
          title="Chat Completions 与 Responses API"
          scale={1.18}
          translateX={42}
          translateY={-36}
        />
      </Sequence>
      <Sequence from={trustStart} durationInFrames={endStart - trustStart}>
        <TrustScene />
      </Sequence>
      <Sequence from={endStart} durationInFrames={DURATION_SECONDS * FPS - endStart}>
        <EndCard />
      </Sequence>
      <BrandBug />
      <CaptionLayer />
      <AudioTrack />
    </AbsoluteFill>
  );
};

export const Root = () => (
  <Composition
    id="LittleAlphaxivV014Promo"
    component={PromoVideo}
    durationInFrames={DURATION_SECONDS * FPS}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={{} as Record<string, never>}
  />
);

