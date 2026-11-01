// The motion-graphics compositions, by template id. Shared by the Remotion root (renders) and
// the desktop's live preview (@remotion/player), so both draw the very same component.
import type { ComponentType } from "react";
import type { MotionTemplateId } from "@reelforge/core/motion-catalog";
import { Badge } from "./templates/Badge.tsx";
import { LowerThird } from "./templates/LowerThird.tsx";
import { TitleCard } from "./templates/TitleCard.tsx";

export const COMPOSITIONS: Record<MotionTemplateId, ComponentType<never>> = {
  "title-card": TitleCard as ComponentType<never>,
  "lower-third": LowerThird as ComponentType<never>,
  badge: Badge as ComponentType<never>,
};
