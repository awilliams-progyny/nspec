/**
 * Centralized workspace root resolution for nSpec.
 * Single source of truth for no-workspace and multi-root behavior:
 * - No folder open → null.
 * - Multiple roots → first folder is used for specs path and workspace root.
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Returns the absolute path to the specs folder (e.g. workspace/.specs),
 * or null if no workspace folder is open.
 */
export function getSpecsRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const config = vscode.workspace.getConfiguration('nspec');
  const specsFolder = config.get<string>('specsFolder', '.specs');
  return path.join(folders[0].uri.fsPath, specsFolder);
}

/**
 * Returns the first workspace folder's fsPath, or null if none.
 */
export function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? null;
}
