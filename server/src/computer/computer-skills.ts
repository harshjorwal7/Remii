/**
 * The computer-use skills: what the Bot is told, in prose, about driving a real desktop.
 *
 * WHY SKILLS AND NOT JUST TOOLS.
 *
 * The desktop tool set is now eleven tools that move a pointer and press keys, and a description of
 * each is not enough to use them well. Every failure mode that made "the Bot cannot use the desktop"
 * true was a reasoning failure, not a missing capability:
 *
 * - It took a screenshot and got told the screen had been photographed, because the tool threw the
 *   pixels away. Fixed in the tool. The SKILL is what stops it happening again by telling the model
 *   that the answer comes back as an image it must actually look at.
 * - It clicked coordinates from the accessibility tree on an XFCE panel where the tree is nearly
 *   empty, so it guessed. The skill says: look at the screen, click what you saw, verify with another
 *   screenshot.
 * - It did not verify an action worked. The single highest-value habit on a GUI, and the one a ReAct
 *   loop does not have by default — every tool call looks like progress, so a click that missed looks
 *   exactly as productive as one that landed.
 *
 * A skill is the right shape for that because it is INSTRUCTIONS, not capability. The tools decide
 * what may be called; the grant decides what the Bot holds; this text decides how sensibly it uses
 * what it has.
 *
 * WHY `tools: []` IS DELIBERATE FOR ALL OF THEM, and this is the important subtlety.
 *
 * `skill_tools` is a DECLARATION, and `declaredBy` in `plugins/selection.ts` intersects it with the
 * Bot's GRANTS. A computer tool's ref is `computer/computer_click`, and those refs never appear in
 * `mcp_tools` — that table is refreshed from MCP servers, and the desktop is a first-party capability
 * rather than a connector. So declaring them here would intersect against grants that cannot contain
 * them, and the intersection would come back empty for every skill.
 *
 * That is the same reason `skill-creator` and `bot-creator` declare nothing: their tools are
 * app-registered rather than connector refs. The declaration table is for narrowing WHICH connector
 * tools to load. These skills narrow nothing — they describe how to drive a machine whose tools are
 * always present or always absent — so they declare nothing and are pure guidance.
 *
 * That also means these skills cannot be used to grant the desktop to a Bot that does not have it.
 * Nothing here grants capability. `botHoldsTheComputer` in `shared/remii.ts` is the only thing that
 * decides that, and this file does not touch it.
 */

import { idleStopPhrase } from "../../../shared/desktop-idle";

/** One built-in skill, as it is written to the database. */
export type ComputerSkillSeed = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

/**
 * The core skill: how to look at a screen and act on it.
 *
 * Written as a loop rather than a reference because that is the shape that works. Every instruction
 * here is a step of "look, act, verify", and the verification step is the one that was missing.
 */
const DRIVE_A_DESKTOP: ComputerSkillSeed = {
  slug: "drive-a-desktop",
  title: "Drive a desktop",
  summary:
    "See the screen, act on it, and check the result — the loop that makes clicking a GUI work.",
  instructions: `You have a real Linux desktop with a screen, a mouse and a keyboard. Working it is a loop, and skipping any part of it is what makes a GUI task fail.

THE LOOP

1. LOOK. Call computer_screen first. It returns the accessibility tree as text — every window,
   button, field and menu with its coordinates — plus the window list. No image tokens, no waiting
   on a screenshot, and the names it gives you are the same ones you click. Do not skip this because
   the previous call "should" still be true.
2. DECIDE. From what you can see, choose one action: a click, a drag, typing, or a key.
3. ACT. One action at a time. Two actions in a row without looking in between means you are acting on
   a screen you have not seen.
4. VERIFY. Call computer_screen again and confirm the action did what you intended — the window or
   field you acted on should now show the expected state. Reach for computer_screenshot only when the
   tree could not tell you what happened (a chart, a colour, an error dialog, a layout).

Step 4 is the one that gets skipped, and skipping it is how a whole turn of work gets thrown away.
A click that lands on the wrong button looks exactly like progress from the inside: the tool answers
"Clicked at 640, 412" and the loop is happy to continue. You are the only thing that can notice that
the page did not change, and only by looking.

READING A SCREEN

- computer_screen returns the accessibility tree as text: names, roles and exact x/y bounds of the
  interactive elements, plus which windows are open. It is free of image tokens, so it is the FIRST
  thing to check after every action, not the fallback.
- computer_screenshot returns a real picture. Use it only when the tree has no name for what you need:
  a chart, a colour, a layout, an error dialog, a page the accessibility tree does not describe. Each
  one costs tokens, so make each one count.
- To read small text, pass a region to computer_screenshot rather than taking the whole screen:
  { region: { x, y, width, height } }. A crop of a form field costs a fraction of a full screenshot
  and is far more legible. This is the difference between squinting and reading.
- A screenshot tells you where the mouse pointer is. Use it: a menu that is open, a button that is
  highlighted, and a field that is focused are all things you should be able to see before you click.

COORDINATES

- Screen coordinates start at the top-left of the desktop, as the screenshot is drawn. The x and y in
  a screenshot, in computer_screen's listing, and in a click are all the same space.
- Click the CENTRE of what you want, not its edge. A button at 500-560 wide is safest clicked at 530.
- The whole desktop is 1920x1080 unless a screenshot says otherwise. Coordinates outside it are refused.

KEYBOARD OVER MOUSE

- computer_type types into whatever has focus, and it does NOT clear the field first. To replace what
  is in a field, select it (ctrl+a) and then type.
- computer_type sends newlines as Return. For a multi-line value this is right; for a single-line
  field it will submit the form, so use it deliberately.
- ctrl+a select all · ctrl+c copy · ctrl+v paste · ctrl+s save · Escape cancel · Tab next field.
  These are almost always faster and far more reliable than clicking at coordinates.
- To dismiss a menu, press Escape rather than clicking empty space.

WHEN AN ACTION DOES NOT WORK

- Nothing moved. Take a screenshot and look before doing anything else. Usually a menu was open, or
  focus was somewhere else, or a dialog appeared over what you were aiming at.
- A field did not take the text. Click the field first, then type. An unclicked field is the single
  most common cause.
- You see an error, a captcha, or a sign-in page. These are walls. Stop and ask the person — call
  computer_request_help and say what you are looking at. Do not try to work around a captcha and do
  not guess at somebody's password.
- The screen is empty or the desktop is not running. Say so plainly and stop. That is a real state, not
  a reason to retry the same click.

DO NOT

- Do not take screenshots in a loop without acting. Looking, looking, looking makes no progress.
- Do not click a coordinate you have not seen in a screenshot or in computer_screen. A plausible
  guess is how a click ends up closing the wrong document.
- Do not use the file and shell tools to work around a GUI task that a person asked you to do on the
  screen. If they asked for something in an application, do it in the application.`,
};

/**
 * The efficiency skill: when the screen is the wrong tool.
 *
 * The desktop is billed by the hour and every screenshot is billed desktop time, so "use the right
 * tool" here is a cost fact and not only a taste one.
 */
const SHELL_AND_FILES: ComputerSkillSeed = {
  slug: "desktop-shell-and-files",
  title: "Desktop shell and files",
  summary:
    "Use the machine's shell and filesystem directly instead of driving windows for anything that is really text.",
  instructions: `You have three ways to do things on this computer: the screen, a shell, and the filesystem. Picking the cheapest one is not just faster — every screenshot is billed desktop time on a machine charged by the hour, and the text of a file is a fraction of the tokens a picture of that file costs.

WHEN TO USE EACH

- computer_shell — anything a command line is for. Searching a directory tree, checking whether a
  process is running, installing or configuring software, running a build, inspecting a log, doing
  anything with pipes. One call, exact output.
- computer_read_file / computer_write_file — reading or creating a file. Reading a file through a text
  editor is three round trips and a screenshot to obtain a string you could have asked for directly.
- computer_list_files — what is in a directory.
- The SCREEN — only what genuinely needs a window: a web page in a browser, a GUI application with no
  command-line equivalent, a dialog, a canvas, anything visual. Also anything where the answer is how
  something LOOKS rather than what it says.

SHELL

- computer_shell takes one command and returns its output and exit code. A non-zero exit is
  information, not a failure: a grep that matched nothing and a command that could not run both come
  back with an exit code that tells you which.
- Quote paths with spaces. Prefer absolute paths — you do not know the working directory of a window.
- Output is truncated at a reasonable length and says so when it cut something off. If it did, narrow
  the command rather than re-running the same one: \`| head\`, \`| tail\`, or a more specific grep.
- Several commands can be joined with && or ; when one genuinely depends on another. Do not chain
  unrelated things — if one fails you will not know which.

FILES

- computer_read_file returns the contents as text. Binary files will not be readable this way; use
  computer_shell for those.
- computer_write_file creates or replaces a whole file. Parent directories are not created for you —
  make them with computer_shell first.
- Before overwriting something, read it. Overwriting a file you have not read is how work is lost.

A WORKED EXAMPLE

Asked to "find every spreadsheet modified this month": do not open a file manager. Run
\`find / -name '*.xlsx' -mtime -30 2>/dev/null\`. One call, the whole answer.

Asked to "what does the dashboard say": that is a web page. Use computer_navigate, which returns the
loaded page as an image, and read it.

Asked to "change the setting in config.yaml": read the file, edit it, write it back. Do not open it in
an editor.`,
};

/**
 * The web skill, because browsing is the single most common reason to touch the desktop at all.
 */
const BROWSING: ComputerSkillSeed = {
  slug: "browse-the-web",
  title: "Browse the web on the desktop",
  summary:
    "Open pages, fill in forms and read what loads — without the six wasted round trips.",
  instructions: `The desktop has a real Chromium on it. This is how you use the web from here.

OPENING A PAGE

- computer_navigate takes a full address including https:// and loads it. It returns the loaded page
  AS AN IMAGE, so you can see whether it worked in the same call — you do not need a follow-up
  screenshot to find out whether the site is up.
- To read the page as text — headings, buttons, links, form fields and the visible text — run
  \`python3 /tmp/remii-dom.py\` through computer_shell. No screenshot tokens, no image. This works
  because Chromium was started with \`--remote-debugging-port=9222\`; a browser started without it
  needs one relaunch to get that flag.
- If it says no browser is open, start one first with computer_shell:
  \`DISPLAY=:0 nohup chromium --no-sandbox --disable-gpu --remote-debugging-port=9222 --remote-allow-origins=* about:blank &\`
  then navigate again.
- After navigating, the page may need a moment. If what comes back is blank, wait briefly and
  check again with computer_screen rather than navigating again — navigating again restarts the load.

FILLING IN FORMS

1. computer_screen. See the form — its fields and labels are in the accessibility tree. Reach for a
   screenshot only when a label or layout is not in the tree.
2. Click each field you need, one at a time.
3. computer_type into the focused field. It does NOT clear the field first: to replace existing
   contents, ctrl+a then type.
4. computer_screen to check the form before you submit it. This is where mistakes are cheap to catch.
5. Submit — by clicking the button, or by pressing Enter if the form submits on Enter.

A form that did not fill correctly and got submitted is much worse than one that took an extra
screenshot to check.

WHAT TO DO ABOUT WALLS

- A captcha, a login, a two-factor code, or an "are you a robot" page: STOP. Call
  computer_request_help and say which page you are on and what it is asking for. These are not
  obstacles to route around.
- A paywall or a pay-to-read article: do not try to get around it. Say what you found and that the
  rest is behind a paywall.
- Do not sign in to anything with credentials you were not given.

READING THE RESULT

- A long page: screenshot the part you need with a region rather than the whole screen, and scroll
  with computer_scroll rather than re-screenshotting repeatedly.
- If you need the text of a page rather than what it looks like, prefer a shell tool that fetches it
  — it is far cheaper and gives you the actual characters instead of your reading of a picture.
- Numbers in a chart, a colour, or whether something is drawn at all: those are questions only a
  picture answers. Take one.`,
};

/**
 * The long-task skill: how to work for twenty minutes without losing the thread.
 *
 * The existing desktop guidance already tells the model the session is capped and the machine sleeps
 * after four idle minutes. This is the operational half of that — what to do when it happens mid-task.
 */
const LONG_TASKS: ComputerSkillSeed = {
  slug: "long-desktop-tasks",
  title: "Long desktop tasks",
  summary:
    "Keep working a desktop for longer than a minute without losing state, wasting time, or billing for nothing.",
  instructions: `The computer is switched off automatically after about ${idleStopPhrase()} of nothing happening, and bringing it back takes a minute or two. A single stretch of work is capped at about twenty minutes. Neither is a reason to stop early; both change how you should work.

BEFORE YOU START

- Look at the screen first, every time, even if you looked a moment ago. A task that begins by
  navigating to a known URL without looking will happily do the whole job on the wrong page.
- Save anything you have already finished before starting the next step. Four minutes is long enough
  to lose unsaved work, and the machine stopping is not a save.

KEEPING THE MACHINE AWAKE

- Any tool call that touches the desktop counts as activity, so keep working steadily rather than
  pausing between steps. A long think with no calls in between is what puts the machine to sleep.
- If a call comes back saying the computer is not running, it is being woken. Wait, then call
  computer_screen to see where things actually are before continuing — do not blindly repeat the action
  that failed, because it may well have been applied before the machine went away.
- Prefer batching. One shell command that does three things beats three round trips.

KEEPING YOUR PLACE

- Do the work in named steps and say which one you are on. Long GUI tasks fail far more often by
  losing track than by being unable to do any individual step.
- After anything that could have failed — a submit, a download, a long install — call computer_screen
  and confirm, rather than proceeding on the assumption that it worked.
- Write intermediate results to a file as you go if the work will outlive one stretch of session.
  The filesystem survives; a screen does not.

WHEN A TASK IS TOO BIG FOR ONE SESSION

- Tell the person. Say what is done, what is not, and what you would do next. That is a useful answer
  and far better than a turn that runs out of time mid-flow with no account of where it got to.
- computer_request_help is for when you are blocked on something only a person can do — a captcha, a
  login, a decision. It is not a way to hand back a task that is merely long.`,
};

export const COMPUTER_SKILLS: readonly ComputerSkillSeed[] = [
  DRIVE_A_DESKTOP,
  SHELL_AND_FILES,
  BROWSING,
  LONG_TASKS,
];

/**
 * The slugs, for a caller that needs to grant them without walking the array.
 *
 * `bot-creator` and `skill-creator` are gated in `index.ts` by an explicit literal rather than by a
 * list like this one, because those two are security gates: whether a Bot may be created at all. These
 * are not — they grant no capability, only guidance — so a list is enough and there is no reason for
 * the two cases to look alike.
 */
export const COMPUTER_SKILL_SLUGS = COMPUTER_SKILLS.map((skill) => skill.slug);
