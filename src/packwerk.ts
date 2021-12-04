import {
  PackwerkOutput,
  PackwerkFile,
  PackwerkViolation,
} from './packwerkOutput';
import { TaskQueue, Task } from './taskQueue';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, PackwerkConfig } from './configuration';
import { parseOutput } from './outputParser';

function isFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file';
}

function getCurrentPath(fileName: string): string {
  return vscode.workspace.rootPath || path.dirname(fileName);
}

// extract argument to an array
function getCommandArguments(fileName: string): string[] {
  let commandArguments = ['--stdin', fileName, '--force-exclusion'];
  const extensionConfig = getConfig();
  if (extensionConfig.configFilePath !== '') {
    let found = [extensionConfig.configFilePath]
      .concat(
        (vscode.workspace.workspaceFolders || []).map((ws: any) =>
          path.join(ws.uri.path, extensionConfig.configFilePath)
        )
      )
      .filter((p: string) => fs.existsSync(p));

    if (found.length == 0) {
      vscode.window.showWarningMessage(
        `${extensionConfig.configFilePath} file does not exist. Ignoring...`
      );
    } else {
      if (found.length > 1) {
        vscode.window.showWarningMessage(
          `Found multiple files (${found}) will use ${found[0]}`
        );
      }
      const config = ['--config', found[0]];
      commandArguments = commandArguments.concat(config);
    }
  }

  return commandArguments;
}

export class Packwerk {
  public config: PackwerkConfig;
  private diag: vscode.DiagnosticCollection;
  private additionalArguments: string[];
  private taskQueue: TaskQueue = new TaskQueue();

  constructor(
    diagnostics: vscode.DiagnosticCollection,
    additionalArguments: string[] = []
  ) {
    this.diag = diagnostics;
    this.additionalArguments = additionalArguments;
    this.config = getConfig();
  }

  public execute(document: vscode.TextDocument, onComplete?: () => void): void {
    if (
      (document.languageId !== 'gemfile' && document.languageId !== 'ruby') ||
      document.isUntitled ||
      !isFileUri(document.uri)
    ) {
      // git diff has ruby-mode. but it is Untitled file.
      return;
    }

    const fileName = document.fileName;
    const uri = document.uri;
    let currentPath = getCurrentPath(fileName);

    let onDidExec = (error: Error, stdout: string, stderr: string) => {
      this.reportError(error, stderr);
      let packwerk = this.parse(stdout);
      if (packwerk === undefined || packwerk === null) {
        return;
      }

      this.diag.delete(uri);

      let entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
      packwerk.files.forEach((file: PackwerkFile) => {
        let diagnostics = [];
        file.violations.forEach((offence: PackwerkViolation) => {
          const loc = offence.location;
          const range = new vscode.Range(
            loc.line - 1,
            loc.column,
            loc.line - 1,
            loc.length + loc.column
          );
          // const sev = this.severity(offence.severity);
          const message = `${offence.message} (${offence.type})`;
          const diagnostic = new vscode.Diagnostic(
            range,
            message,
            vscode.DiagnosticSeverity.Error
          );
          diagnostics.push(diagnostic);
        });
        entries.push([uri, diagnostics]);
      });

      this.diag.set(entries);
    };

    const jsonOutputFormat = ['--format', 'json'];
    const args = getCommandArguments(fileName)
      .concat(this.additionalArguments)
      .concat(jsonOutputFormat);

    let task = new Task(uri, (token) => {
      let process = this.executePackwerk(
        args,
        document.getText(),
        { cwd: currentPath },
        (error, stdout, stderr) => {
          if (token.isCanceled) {
            return;
          }
          onDidExec(error, stdout, stderr);
          token.finished();
          if (onComplete) {
            onComplete();
          }
        }
      );
      return () => process.kill();
    });
    this.taskQueue.enqueue(task);
  }

  public get isOnSave(): boolean {
    return this.config.onSave;
  }

  public clear(document: vscode.TextDocument): void {
    let uri = document.uri;
    if (isFileUri(uri)) {
      this.taskQueue.cancel(uri);
      this.diag.delete(uri);
    }
  }

  // execute packwerk
  private executePackwerk(
    args: string[],
    fileContents: string,
    options: cp.ExecOptions,
    cb: (err: Error, stdout: string, stderr: string) => void
  ): cp.ChildProcess {
    let child;
    if (this.config.useBundler) {
      child = cp.exec(`${this.config.command} ${args.join(' ')}`, options, cb);
    } else {
      child = cp.execFile(this.config.command, args, options, cb);
    }
    child.stdin.write(fileContents);
    child.stdin.end();
    return child;
  }

  // parse packwerk(JSON) output
  private parse(output: string): PackwerkOutput | null {
    let packwerk: PackwerkOutput;
    if (output.length < 1) {
      let message = `command ${this.config.command} returns empty output! please check configuration.`;
      vscode.window.showWarningMessage(message);

      return null;
    }

    try {
      packwerk = parseOutput(output);
    } catch (e) {
      if (e instanceof SyntaxError) {
        let regex = /[\r\n \t]/g;
        let message = output.replace(regex, ' ');
        let errorMessage = `Error on parsing output (It might non-JSON output) : "${message}"`;
        vscode.window.showWarningMessage(errorMessage);

        return null;
      }
    }

    return packwerk;
  }

  // checking packwerk output has error
  private reportError(error: Error, stderr: string): boolean {
    let errorOutput = stderr.toString();
    if (error && (<any>error).code === 'ENOENT') {
      vscode.window.showWarningMessage(
        `${this.config.command} is not executable`
      );
      return true;
    } else if (error && (<any>error).code === 127) {
      vscode.window.showWarningMessage(stderr);
      return true;
    } else if (errorOutput.length > 0) {
      vscode.window.showWarningMessage(stderr);
      return true;
    }

    return false;
  }
}
