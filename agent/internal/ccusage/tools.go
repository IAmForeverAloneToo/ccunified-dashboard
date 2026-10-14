package ccusage

// Tool is a coding tool whose usage ccusage reads.
type Tool struct {
	// ID is ccusage's name for the tool, used in uploads ("claude", "codex", …).
	ID string
	// Name is how ccusage's help describes it.
	Name string
}

// Tools are the tools the pinned ccusage reads, in the order its help lists
// them. TestToolsMatchPinnedCcusage checks this list against the program;
// update it with each new ccusage.
var Tools = []Tool{
	{"claude", "Claude Code"},
	{"codex", "Codex"},
	{"opencode", "OpenCode"},
	{"amp", "Amp"},
	{"droid", "Droid"},
	{"codebuff", "Codebuff"},
	{"hermes", "Hermes"},
	{"pi", "pi-agent"},
	{"goose", "Goose"},
	{"kilo", "Kilo"},
	{"copilot", "GitHub Copilot CLI"},
	{"gemini", "Gemini CLI"},
	{"antigravity", "Antigravity"},
	{"kimi", "Kimi"},
	{"qwen", "Qwen"},
	{"openclaw", "OpenClaw"},
	{"grok", "Grok Build CLI"},
	{"zcode", "ZCode"},
}

// ToolName returns a tool's display name, or its id if it isn't known.
func ToolName(id string) string {
	for _, t := range Tools {
		if t.ID == id {
			return t.Name
		}
	}
	return id
}
