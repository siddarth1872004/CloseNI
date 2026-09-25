/*
 * Getting started: what a first launch needs, in the order it needs it.
 *
 * Loaded by index.html (window.CNOnboarding) and require()d by the test
 * harness. There is no bundler, so no import/export.
 *
 * A first launch used to land on an empty chat with no workspace, no provider
 * signed in and a Build button that could not work, and nothing said which of
 * those came first. The order is not arbitrary: a workspace is where the
 * conversation is saved, so it comes before signing in; signing in comes before
 * the first message, which is where every "no chat input appeared" error was
 * really coming from.
 *
 * Every step is derived from state the app already holds - never from a
 * "completed" flag of its own. A checklist that ticks a box because a button
 * was clicked will say "signed in" beside a sign-in that failed; one that reads
 * the account light cannot.
 */
(function (root) {
  var DISMISS_KEY = "closeni.onboarding";

  /*
   * Small on purpose. A worked example should come back as a two- or three-step
   * plan in about a minute, so the first build a person watches finishes. It
   * names a language and a file, because a vague prompt gets a vague plan, and
   * asks for tests, because the Test panel is the third thing to learn.
   */
  var EXAMPLE_PROMPT =
    "I want a small Python command-line tool, convert.py, that converts temperatures " +
    "between Celsius and Fahrenheit. Usage: python convert.py 100 C prints 212.0 F. " +
    "Reject input that is not a number with a clear message, and include unit tests.";

  /**
   * The account light's state, read as a sign-in step.
   *
   * "unknown" is not "signed out". The light starts unknown and the check costs
   * a headless browser launch, so it runs once per launch; treating unknown as
   * signed out would send someone who is already signed in to sign in again.
   */
  function signInStatus(account) {
    if (account === "on") return "done";
    if (account === "busy") return "checking";
    if (account === "off") return "todo";
    return "unknown";
  }

  /**
   * The steps, each with whether it is done and what its button does.
   *
   * state: { browserReady, workspace, account, providerName, chatted }
   *   account      the account light: "on" | "off" | "busy" | "unknown"
   *   chatted      whether this session has sent a message
   */
  function steps(state) {
    var s = state || {};
    var name = s.providerName || "your provider";
    var signIn = signInStatus(s.account);

    return [
      {
        id: "browser",
        title: "Browser downloaded",
        detail: "CloseNI talks to " + name + " through its own copy of Chromium, " +
          "so nothing touches the browser you normally use.",
        done: s.browserReady !== false,
        action: s.browserReady === false ? "Download browser" : null,
      },
      {
        id: "workspace",
        title: "Choose a project folder",
        detail: "Generated files are written here, and the conversation for " +
          "this project is saved with it. An empty folder is the easiest start.",
        done: !!s.workspace,
        action: s.workspace ? null : "Choose folder",
      },
      {
        id: "signin",
        title: signIn === "checking" ? "Checking your " + name + " sign-in…" : "Sign in to " + name,
        detail: signIn === "unknown"
          ? "Not checked yet. Check first - you may already be signed in from last time."
          : "A browser window opens on " + name + "'s site. Sign in as you normally " +
            "would; it closes by itself once the chat box appears. The login stays in " +
            "CloseNI's own profile on this machine, and no password is ever seen by the app.",
        done: signIn === "done",
        action: signIn === "done" || signIn === "checking" ? null
          : signIn === "unknown" ? "Check" : "Sign in",
      },
      {
        id: "prompt",
        title: "Describe something to build",
        detail: "Chat about the idea, press Generate Implementation Plan, read the " +
          "plan, then Build with this. The Test panel runs the result.",
        done: !!s.chatted,
        action: s.chatted ? null : "Use an example",
      },
    ];
  }

  /** The first step not yet done, or null when there is nothing left to do. */
  function current(state) {
    var list = steps(state);
    for (var i = 0; i < list.length; i++) if (!list[i].done) return list[i].id;
    return null;
  }

  /**
   * Whether the guide belongs on screen.
   *
   * Gone once everything is done, and gone for good once dismissed: someone who
   * closed it knows the order, and a guide that returns every launch is noise.
   * Settings can bring it back.
   */
  function visible(state, dismissed) {
    if (dismissed) return false;
    return current(state) !== null;
  }

  /** Whether a stored value means the guide was dismissed. */
  function isDismissed(stored) {
    return stored === "dismissed";
  }

  var api = {
    DISMISS_KEY: DISMISS_KEY,
    EXAMPLE_PROMPT: EXAMPLE_PROMPT,
    steps: steps,
    current: current,
    visible: visible,
    isDismissed: isDismissed,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNOnboarding = api;
})(typeof window !== "undefined" ? window : globalThis);
