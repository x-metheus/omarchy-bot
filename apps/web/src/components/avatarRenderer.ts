import { Avatar as CurrentAvatar, Style as CurrentStyle } from "@dicebear/core";
import { AVATAR_RENDERER_ID, AVATAR_STYLE_IDS, type AvatarRecipeDto } from "@omarchy-bot/protocol";
import currentClayDefinition from "@dicebear/styles/clay.json";
import currentCrittersDefinition from "@dicebear/styles/critters.json";
import currentGazeDefinition from "@dicebear/styles/gaze.json";
import currentInitialFaceDefinition from "@dicebear/styles/initial-face.json";
import currentMoodsDefinition from "@dicebear/styles/moods.json";
import currentPixelbotDefinition from "@dicebear/styles/pixelbot.json";
import currentShapesDefinition from "@dicebear/styles/shapes.json";
import currentSproutsDefinition from "@dicebear/styles/sprouts.json";
import currentThumbsDefinition from "@dicebear/styles/thumbs.json";
import currentVoxelArtDefinition from "@dicebear/styles/voxel-art.json";
import currentVoxelBotDefinition from "@dicebear/styles/voxel-bot.json";

export type AvatarPresentation = "static" | "ambient" | "working";

const currentStyles: Record<(typeof AVATAR_STYLE_IDS)[number], CurrentStyle> = {
  clay: new CurrentStyle(currentClayDefinition),
  critters: new CurrentStyle(currentCrittersDefinition),
  gaze: new CurrentStyle(currentGazeDefinition),
  "initial-face": new CurrentStyle(currentInitialFaceDefinition),
  moods: new CurrentStyle(currentMoodsDefinition),
  pixelbot: new CurrentStyle(currentPixelbotDefinition),
  shapes: new CurrentStyle(currentShapesDefinition),
  sprouts: new CurrentStyle(currentSproutsDefinition),
  thumbs: new CurrentStyle(currentThumbsDefinition),
  "voxel-art": new CurrentStyle(currentVoxelArtDefinition),
  "voxel-bot": new CurrentStyle(currentVoxelBotDefinition),
};

const MAX_CACHE_ENTRIES = 256;
const svgCache = new Map<string, string>();

function animationOptions(presentation: AvatarPresentation): { animation: true; animationSpeed: number } | undefined {
  switch (presentation) {
    case "ambient":
      return { animation: true, animationSpeed: 1 };
    case "working":
      return { animation: true, animationSpeed: 1.25 };
    case "static":
      return undefined;
  }
}

function cacheKey(recipe: AvatarRecipeDto, presentation: AvatarPresentation): string {
  return JSON.stringify([
    recipe.rendererVersion,
    recipe.style,
    recipe.seed,
    Object.entries(recipe.options).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    presentation,
  ]);
}

function remember(key: string, dataUri: string): string {
  svgCache.set(key, dataUri);
  if (svgCache.size > MAX_CACHE_ENTRIES) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  return dataUri;
}

function renderCurrent(recipe: AvatarRecipeDto, presentation: AvatarPresentation): string {
  const style = currentStyles[recipe.style];
  const animation = animationOptions(presentation);
  const options = animation === undefined
    ? { ...(recipe.options as object), seed: recipe.seed }
    : { ...(recipe.options as object), seed: recipe.seed, ...animation };
  return new CurrentAvatar(style, options).toDataUri();
}

/** Render a validated recipe with the application's sole pinned renderer. */
export function renderAvatarRecipe(recipe: AvatarRecipeDto, presentation: AvatarPresentation): string {
  const key = cacheKey(recipe, presentation);
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    svgCache.delete(key);
    svgCache.set(key, cached);
    return cached;
  }

  return remember(key, renderCurrent(recipe, presentation));
}
