import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    console.log('Agentic Web Coder is now active!');

    let disposable = vscode.commands.registerCommand('agentic-web-coder.askAI', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage("Please open a workspace folder first.");
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        const prompt = await vscode.window.showInputBox({
            prompt: "What do you want the AI to code?",
            placeHolder: "e.g., Create a new file src/utils.ts with a function that adds two numbers"
        });

        if (!prompt) return;

        const config = vscode.workspace.getConfiguration('agenticWebCoder');
        const provider = config.get<string>('provider', 'deepseek');

        // Path to the local agent
        const agentPath = path.join(context.extensionPath, '..', 'local-agent', 'dist', 'index.js');
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Asking ${provider} (Browser will open)...`,
            cancellable: false
        }, async (progress) => {
            
            return new Promise<void>((resolve) => {
                const child = spawn('node', [agentPath, 'browser', prompt, workspaceRoot, provider], {
                    cwd: path.join(context.extensionPath, '..')
                });

                let output = '';

                child.stdout.on('data', (data) => {
                    const text = data.toString();
                    output += text;
                    
                    if (text.includes('Waiting for manual login')) {
                        vscode.window.showInformationMessage('Please log in to the AI provider in the browser window.');
                    }
                    if (text.includes('Typing prompt')) {
                        vscode.window.showInformationMessage('Sending prompt to AI...');
                    }
                    if (text.includes('Response complete')) {
                        vscode.window.showInformationMessage('Parsing AI response and applying patches...');
                    }
                });

                child.stderr.on('data', (data) => {
                    console.error(`Agent Error: ${data}`);
                });

                child.on('close', (code) => {
                    try {
                        const startIdx = output.indexOf('AGENT_OUTPUT_START');
                        const endIdx = output.indexOf('AGENT_OUTPUT_END');
                        if (startIdx !== -1 && endIdx !== -1) {
                            const between = output.substring(startIdx + 18, endIdx);
                            const jsonLines = between.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{'));
                            const jsonStr = jsonLines[jsonLines.length - 1] || '{}';
                            const result = JSON.parse(jsonStr);
                            
                            if (result.success) {
                                vscode.window.showInformationMessage(`Success! Applied changes to: ${result.appliedFiles.join(', ')}`);
                                // Open the first modified file
                                if (result.appliedFiles.length > 0) {
                                    const filePath = path.join(workspaceRoot, result.appliedFiles[0]);
                                    vscode.window.showTextDocument(vscode.Uri.file(filePath));
                                }
                            } else {
                                vscode.window.showErrorMessage(`Agent failed: ${result.error || 'Unknown error'}`);
                            }
                        } else {
                            vscode.window.showErrorMessage("Agent finished but returned no valid output.");
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Error parsing agent output: ${e.message}`);
                    }
                    resolve();
                });
            });
        });
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

