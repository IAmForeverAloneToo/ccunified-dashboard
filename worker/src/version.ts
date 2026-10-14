// Replaced at build time with the release version.
declare const __CCUNIFIED_VERSION__: string | undefined;

export const SERVER_VERSION: string =
  typeof __CCUNIFIED_VERSION__ === "string" ? __CCUNIFIED_VERSION__ : "dev";
