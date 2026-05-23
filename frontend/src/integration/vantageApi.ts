/** REST client for VANTAGE backend at localhost:8000 */

export async function startVantagePipeline(
  prompt: string,
  workspacePath: string,
  apiKey: string
): Promise<{ session_id: string } | { error: string }> {
  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      workspace_path: workspacePath,
      google_api_key: apiKey,
    }),
  });
  return res.json();
}

export async function approvePlan(
  sessionId: string,
  approved: boolean = true
): Promise<void> {
  await fetch('/api/approve-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, approved }),
  });
}

export async function resolveHITL(
  sessionId: string,
  approved: boolean
): Promise<void> {
  await fetch('/api/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, approved }),
  });
}

export async function stopVantagePipeline(sessionId: string): Promise<void> {
  await fetch(`/api/stop/${sessionId}`, { method: 'POST' });
}

export async function fetchWorkspaceTree(
  workspacePath: string
): Promise<{ tree: any[]; error?: string }> {
  try {
    const res = await fetch(
      `/api/workspace-tree?path=${encodeURIComponent(workspacePath)}`
    );
    return res.json();
  } catch {
    return { tree: [] };
  }
}
