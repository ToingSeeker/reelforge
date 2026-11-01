import { Composition, type CalculateMetadataFunction } from "remotion";
import { MOTION_TEMPLATES, MOTION_TEMPLATE_IDS } from "@reelforge/core/motion-catalog";
import { COMPOSITIONS } from "./compositions.tsx";

/** Render input: the template's props plus the frame the engine wants (project size, rate, length). */
type Input = Record<string, unknown> & { frame?: { width: number; height: number; fps: number; durationInFrames: number } };

const metadata: CalculateMetadataFunction<Input> = ({ props }) => (props.frame ? { ...props.frame } : {});

export function Root() {
  return (
    <>
      {MOTION_TEMPLATE_IDS.map((id) => (
        <Composition
          key={id}
          id={id}
          component={COMPOSITIONS[id] as never}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={Math.round(MOTION_TEMPLATES[id].defaultSeconds * 30)}
          defaultProps={MOTION_TEMPLATES[id].defaults as Input}
          calculateMetadata={metadata}
        />
      ))}
    </>
  );
}
