import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";

// Minimal type surface for extension compilation when running inside the repo.
// The published @mariozechner/pi-coding-agent types do not currently export
// ExtensionAPI / ExtensionContext, but they exist at runtime.

declare module "@mariozechner/pi-coding-agent" {
	export type UiNotifyLevel = "info" | "warning" | "error";

	export interface ExtensionUI {
		notify(message: string, level: UiNotifyLevel): void;
		setFooter(
			factory?: (
				tui: { requestRender(): void },
				theme: { fg(token: string, text: string): string },
				footerData: {
					getGitBranch(): string | null;
					getAvailableProviderCount(): number;
					onBranchChange?(callback: () => void): () => void;
				},
			) => {
				render(width: number): string[];
				invalidate(): void;
				dispose?(): void;
			},
		): void;
		input(prompt: string): Promise<string | undefined>;
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
	}

	export interface ExtensionContext {
		ui: ExtensionUI;
		sessionManager: {
			getEntries(): Array<
				| { type: "message"; message: AssistantMessage }
				| { type: string; message?: unknown }
			>;
			getSessionName(): string | undefined;
		};
		model?: Model<Api>;
	}

	export interface ExtensionCommandContext extends ExtensionContext {}

	export interface ExtensionAPI {
		getThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

		exec(
			command: string,
			args: string[],
			options?: {
				cwd?: string;
				env?: Record<string, string>;
				timeout?: number;
			},
		): Promise<{
			stdout: string;
			stderr: string;
			code: number | null;
			killed: boolean;
		}>;
		registerProvider(
			name: string,
			config: {
				baseUrl: string;
				apiKey: string;
				api: Api;
				streamSimple: (
					model: Model<Api>,
					context: Context,
					options?: SimpleStreamOptions,
				) => AssistantMessageEventStream;
				models: Array<{
					id: string;
					name: string;
					reasoning: boolean;
					input: ("text" | "image")[];
					cost: {
						input: number;
						output: number;
						cacheRead: number;
						cacheWrite: number;
					};
					contextWindow: number;
					maxTokens: number;
				}>;
			},
		): void;

		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void;

		on(
			event: "session_start",
			handler: (event: unknown, ctx: ExtensionContext) => void,
		): void;
		on(
			event: "session_switch",
			handler: (event: { reason?: string }, ctx: ExtensionContext) => void,
		): void;
	}
}
