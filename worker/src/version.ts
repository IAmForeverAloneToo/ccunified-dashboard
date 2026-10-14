// Replaced at build time.
declare const __CCUNIFIED_VERSION__: string | undefined;
declare const __CCUNIFIED_REPO__: string | undefined;

/** The version of this Worker build ("dev" for local builds). */
export const SERVER_VERSION: string =
  typeof __CCUNIFIED_VERSION__ === "string" ? __CCUNIFIED_VERSION__ : "dev";

/** The public GitHub repository releases are published from. */
export const SOURCE_REPO: string =
  typeof __CCUNIFIED_REPO__ === "string"
    ? __CCUNIFIED_REPO__
    : "IAmForeverAloneToo/ccunified-dashboard";
