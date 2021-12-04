import * as vs from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as path from 'path';
import { Packwerk } from './packwerk';

export interface PackwerkConfig {
  command: string;
  onSave: boolean;
  configFilePath: string;
  useBundler: boolean;
}

const detectBundledPackwerk: () => boolean = () => {
  try {
    cp.execSync('bundle show packwerk', { cwd: vs.workspace.rootPath });
    return true;
  } catch (e) {
    return false;
  }
};

const autodetectExecutePath: (cmd: string) => string = (cmd) => {
  const key: string = 'PATH';
  let paths = process.env[key];
  if (!paths) {
    return '';
  }

  let pathparts = paths.split(path.delimiter);
  for (let i = 0; i < pathparts.length; i++) {
    let binpath = path.join(pathparts[i], cmd);
    if (fs.existsSync(binpath)) {
      return pathparts[i] + path.sep;
    }
  }

  return '';
};

/**
 * Read the workspace configuration for 'ruby.packwerk' and return a PackwerkConfig.
 * @return {PackwerkConfig} config object
 */
export const getConfig: () => PackwerkConfig = () => {
  const cmd = 'bin/packwerk check';
  const conf = vs.workspace.getConfiguration('ruby.packwerk');
  let useBundler = conf.get('useBundler', false);
  let configPath = conf.get('executePath', '');
  let command: string;

  // if executePath is present in workspace config, use it.
  if (configPath.length !== 0) {
    command = configPath + cmd;
  } else if (useBundler || detectBundledPackwerk()) {
    useBundler = true;
    command = `bundle exec ${cmd}`;
  } else {
    const detectedPath = autodetectExecutePath(cmd);
    if (0 === detectedPath.length) {
      vs.window.showWarningMessage(
        'execute path is empty! please check ruby.packwerk.executePath'
      );
    }
    command = detectedPath + cmd;
  }

  return {
    command,
    configFilePath: conf.get('configFilePath', ''),
    onSave: conf.get('onSave', true),
    useBundler,
  };
};

export const onDidChangeConfiguration: (packwerk: Packwerk) => () => void = (
  packwerk
) => {
  return () => (packwerk.config = getConfig());
};
