declare module "virtual:dashboard-assets" {
  /** Dashboard files keyed by URL path ("/index.html", "/assets/app-1a2b.js", ...). */
  export const assets: Record<string, { type: string; body: string }>;
}
