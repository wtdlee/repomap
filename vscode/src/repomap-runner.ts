import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AnalysisResult } from './repomap-types';

const execFileAsync = promisify(execFile);

export type GenerateReportArgs = {
  workspaceRoot: string;
  npxSpecifier: string;
  outputDir: string;
  useTemp: boolean;
};

function getNpxCommand(): { cmd: string; argsPrefix: string[] } {
  // Use OS-specific executable name.
  if (process.platform === 'win32') {
    return { cmd: 'npx.cmd', argsPrefix: [] };
  }
  return { cmd: 'npx', argsPrefix: [] };
}

export async function generateReportJson(
  args: GenerateReportArgs
): Promise<{ report: AnalysisResult; reportPath: string }> {
  const { cmd, argsPrefix } = getNpxCommand();

  const outAbs = path.isAbsolute(args.outputDir)
    ? args.outputDir
    : path.join(args.workspaceRoot, args.outputDir);

  await fs.mkdir(outAbs, { recursive: true });

  const npxArgs = [
    ...argsPrefix,
    args.npxSpecifier,
    'generate',
    '--format',
    'json',
    ...(args.useTemp ? ['--temp'] : []),
    // If outputDir is set, it takes precedence over --temp in repomap CLI.
    '--output',
    outAbs,
    '--ci',
  ];

  // Run in workspace root so repomap analyzes the opened project.
  await execFileAsync(cmd, npxArgs, {
    cwd: args.workspaceRoot,
    maxBuffer: 1024 * 1024 * 20,
  });

  const reportPath = path.join(outAbs, 'report.json');
  if (!existsSync(reportPath)) {
    throw new Error(`report.json not found at: ${reportPath}`);
  }

  const raw = await fs.readFile(reportPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  const report = extractAnalysisResult(parsed);
  if (!report) {
    throw new Error(
      'Unsupported report.json schema. Expected AnalysisResult or DocumentationReport.repositories[].analysis.'
    );
  }

  return { report, reportPath };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function extractAnalysisResult(root: unknown): AnalysisResult | null {
  // Case 1: direct AnalysisResult (single repo)
  if (isRecord(root) && Array.isArray(root.pages) && Array.isArray(root.components)) {
    return root as AnalysisResult;
  }

  // Case 2: DocumentationReport { repositories: [{ analysis: AnalysisResult, ... }] }
  if (isRecord(root) && Array.isArray(root.repositories)) {
    const repos = root.repositories as unknown[];
    for (const r of repos) {
      if (!isRecord(r)) continue;
      const analysis = r.analysis;
      if (isRecord(analysis) && Array.isArray(analysis.pages) && Array.isArray(analysis.components)) {
        return analysis as AnalysisResult;
      }
    }
  }

  return null;
}
