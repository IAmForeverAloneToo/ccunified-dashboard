import "./styles.css";
import { isAdmin, managesSomething, seesAll } from "./lib/access";
import { ApiError, api, type Me, onAuthProblem, type PairingRequest } from "./lib/api";
import { clear, closeDialogs, h, toast } from "./lib/dom";
import { logo } from "./lib/logo";
import { accountPage } from "./pages/account";
import { approvePage } from "./pages/approve";
import { changePasswordPage } from "./pages/change-password";
import { departmentsPage } from "./pages/departments";
import { loginPage } from "./pages/login";
import { machinesPage } from "./pages/machines";
import { overviewPage } from "./pages/overview";
import { settingsPage } from "./pages/settings";
import { usersPage } from "./pages/users";

export interface PageContext {
  main: HTMLElement;
  me: Me;
  query: URLSearchParams;
  navigate: (path: string, replace?: boolean) => void;
  /** Re-reads the logged-in user (after a password or 2FA change). */
  refreshMe: () => Promise<void>;
  /** Re-checks how many machines wait for approval (updates the nav badge). */
  refreshApprovals: () => void;
}

type Cleanup = () => void;
type Page = (ctx: PageContext) => Promise<Cleanup | undefined> | Cleanup | undefined;

interface Route {
  title: string;
  page: Page;
  /** Who may use the page (everyone if absent); others don't see it in the menu. */
  allow?: (me: Me) => boolean;
  nav?: string;
}

const ROUTES: Record<string, Route> = {
  "/": { title: "Overview", page: overviewPage, nav: "Overview" },
  "/machines": { title: "Machines", page: machinesPage, nav: "Machines" },
  "/approve": {
    title: "Approve a machine",
    page: approvePage,
    allow: managesSomething,
    nav: "Approvals",
  },
  "/users": { title: "Users", page: usersPage, allow: managesSomething, nav: "Users" },
  "/departments": {
    title: "Departments",
    page: departmentsPage,
    allow: isAdmin,
    nav: "Departments",
  },
  "/settings": { title: "Settings", page: settingsPage, allow: seesAll, nav: "Settings" },
  "/account": { title: "Your account", page: accountPage },
};

const root = document.querySelector<HTMLElement>("#app") ?? document.body;
let me: Me | null = null;
let cleanup: Cleanup | undefined;
let approvalsTimer: number | undefined;
let approvalsCount = 0;

// ---------- Theme ----------

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("ccu-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("ccu-theme", theme);
  } catch {
    // Private mode: the choice lasts until reload.
  }
}

applyTheme(readTheme());

const THEME_LABEL: Record<Theme, string> = {
  system: "Theme: system",
  light: "Theme: light",
  dark: "Theme: dark",
};

// ---------- Navigation ----------

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  void render();
}

window.addEventListener("popstate", () => void render());

document.addEventListener("click", (event) => {
  const a = (event.target as Element | null)?.closest?.("a");
  if (
    !a ||
    a.target ||
    a.hasAttribute("download") ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey
  ) {
    return;
  }
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});

onAuthProblem((error) => {
  if (error.code === "password_change_required") {
    navigate("/change-password", true);
  } else if (location.pathname !== "/login") {
    me = null;
    navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, true);
  }
});

async function loadMe(): Promise<Me | null> {
  try {
    return await api<Me>("/me", { quietAuth: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

function refreshApprovals(): void {
  if (!me || !managesSomething(me)) return;
  api<{ requests: PairingRequest[] }>("/pairing")
    .then((r) => {
      approvalsCount = r.requests.length;
      const badge = document.querySelector("#approvals-badge");
      if (badge) {
        badge.textContent = String(approvalsCount);
        badge.toggleAttribute("hidden", approvalsCount === 0);
      }
    })
    .catch(() => {
      // Shown again on the next poll.
    });
}

function shell(route: Route): HTMLElement {
  const path = location.pathname;
  const user = me as Me;
  const themeButton = h("button", { type: "button", class: "small" }, THEME_LABEL[readTheme()]);
  themeButton.addEventListener("click", () => {
    const order: Theme[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(readTheme()) + 1) % order.length] ?? "system";
    applyTheme(next);
    themeButton.textContent = THEME_LABEL[next];
  });

  const links = Object.entries(ROUTES)
    .filter(([, r]) => r.nav && (!r.allow || r.allow(user)))
    .map(([p, r]) =>
      h(
        "a",
        { href: p, "aria-current": p === path ? "page" : undefined },
        r.nav,
        p === "/approve"
          ? h(
              "span",
              {
                class: "badge",
                id: "approvals-badge",
                hidden: approvalsCount === 0,
                "aria-label": "machines waiting",
              },
              String(approvalsCount),
            )
          : null,
      ),
    );

  const main = h("main", { class: "main", id: "main" });
  document.title = `${route.title} · ccunified`;
  root.replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h(
        "div",
        { class: "topbar-inner" },
        h("a", { class: "brand", href: "/" }, logo(), "ccunified"),
        h("nav", { class: "nav", "aria-label": "Main" }, links),
        h(
          "div",
          { class: "user-menu" },
          themeButton,
          h("a", { href: "/account", class: "button small", title: "Your account" }, user.username),
          h(
            "button",
            {
              type: "button",
              class: "small",
              onclick: async () => {
                await api("/logout", { method: "POST" }).catch(() => undefined);
                me = null;
                navigate("/login", true);
              },
            },
            "Log out",
          ),
        ),
      ),
    ),
    main,
  );
  return main;
}

/** Where to go after logging in: a page of this dashboard, or the overview. */
function nextPath(next: string | null): string {
  if (!next?.startsWith("/")) return "/";
  try {
    // The browser's own reading, so "/\evil.example" or a tab can't lead elsewhere.
    const url = new URL(next, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

async function render(): Promise<void> {
  cleanup?.();
  cleanup = undefined;
  // A dialog belongs to the page it was opened on (and may show a secret).
  closeDialogs();
  const path = location.pathname;
  const query = new URLSearchParams(location.search);

  if (path === "/login") {
    me = null;
    window.clearInterval(approvalsTimer);
    approvalsTimer = undefined;
    document.title = "Log in · ccunified";
    cleanup = loginPage(root, query, (user) => {
      me = null; // read in full from /api/me
      navigate(user.must_change_password ? "/change-password" : nextPath(query.get("next")), true);
    });
    return;
  }

  me ??= await loadMe();
  if (!me) {
    navigate(`/login?next=${encodeURIComponent(path + location.search)}`, true);
    return;
  }

  const ctx: Omit<PageContext, "main"> = {
    me,
    query,
    navigate,
    refreshMe: async () => {
      // Update in place: pages hold on to ctx.me.
      const fresh = await loadMe();
      if (fresh && me) Object.assign(me, fresh);
      else me = fresh;
    },
    refreshApprovals,
  };

  if (path === "/change-password") {
    document.title = "Choose a new password · ccunified";
    clear(root);
    const main = h("main", { class: "auth-page" });
    root.append(main);
    cleanup = changePasswordPage({ ...ctx, main });
    return;
  }
  if (me.must_change_password) {
    navigate("/change-password", true);
    return;
  }

  const route = ROUTES[path];
  if (!route) {
    const main = shell({ title: "Not found", page: () => undefined });
    main.append(
      h(
        "div",
        { class: "card empty" },
        h("h1", null, "Page not found"),
        h("a", { href: "/" }, "Go to the overview"),
      ),
    );
    return;
  }
  const main = shell(route);
  if (route.allow && !route.allow(me)) {
    main.append(
      h(
        "div",
        { class: "card empty" },
        h("h1", null, "Not available to you"),
        h("p", null, "Ask an admin of this dashboard if you need this page."),
      ),
    );
    return;
  }
  if (managesSomething(me) && approvalsTimer === undefined) {
    refreshApprovals();
    approvalsTimer = window.setInterval(refreshApprovals, 30_000);
  }
  try {
    cleanup = (await route.page({ ...ctx, main })) ?? undefined;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.code === "password_change_required"))
      return;
    console.error(e);
    main.append(
      h(
        "div",
        { class: "banner error", role: "alert" },
        h("span", { class: "icon" }, "!"),
        "Something went wrong loading this page. Try reloading.",
      ),
    );
    toast("Something went wrong.");
  }
}

void render();
