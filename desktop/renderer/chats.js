/*
 * The chat list for the open workspace: switching between saved chats and
 * starting a new one.
 */

let availableChats = [];
let currentChatIndex = 0;

function updateChatSelector() {
  const select = $("chat-select");
  if (!select) return;
  select.innerHTML = '<option value="new">+ New Chat</option>';
  availableChats.forEach((chat, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = chat.title || ("Chat " + (i + 1));
    if (i === currentChatIndex) opt.selected = true;
    select.appendChild(opt);
  });
}

async function loadChatsForWorkspace() {
    if (!workspace) return;
    try {
      const res = await window.api.getChats(workspace);
      availableChats = res.chats || [];
      currentChatIndex = -1;
      updateChatSelector();
      renderOnboarding();
    } catch (e) {
      console.log("Failed to load chats (first time?):", e);
      availableChats = [];
      currentChatIndex = -1;
      updateChatSelector();
    }
  }

$("chat-select").onchange = function (e) {
  const val = e.target.value;
  if (val === "new") {
    window.api.newChat(workspace).then(() => {
      currentChatIndex = -1;
      toast("Started new chat");
      log("New chat started", "ok");
    }).catch((err) => {
      log("Could not start new chat: " + err.message, "err");
    });
  } else {
    currentChatIndex = parseInt(val);
    const chat = availableChats[currentChatIndex];
    if (chat) {
      window.api.switchChat(workspace, chat.url).then(() => {
        toast("Switched to: " + chat.title);
        log("Switched to chat: " + chat.title, "ok");
      }).catch((err) => {
        log("Could not switch chat: " + err.message, "err");
      });
    }
  }
};

/**
 * Start a new chat.
 *
 * Clearing activeChat in sessions.json is only half of it: the transcript the
 * next plan is built from lives in chatHistory, and the messages the user can
 * see live in the DOM. Without clearing both, pressing this did nothing visible
 * and the old conversation still went into the next plan.
 */
$("new-chat-btn").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const r = await window.api.newChat(workspace).catch(function (e) { return { ok: false, error: String(e) }; });
  if (!r || !r.ok) { toast((r && r.error) || "Could not start a new chat", "err"); return; }

  chatHistory = [];
  currentChatIndex = -1;
  currentPlan = null;
  const flow = $("chat-flow");
  if (flow) flow.innerHTML = "";
  const planContent = $("plan-content");
  if (planContent) planContent.innerHTML = "";
  const sidebar = $("plan-sidebar");
  if (sidebar) sidebar.classList.add("hidden");
  await loadChatsForWorkspace();

  toast("Started new chat");
  log("new chat started - transcript cleared", "ok");
};
