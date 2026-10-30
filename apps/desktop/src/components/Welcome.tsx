import { Icon, LogoMark } from "../icons.tsx";

export function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <main className="rf-center-state">
      <LogoMark size={56} />
      <h1>Welcome to ReelForge</h1>
      <p>Create a project to start. Everything stays on this Mac. The CLI and MCP clients see the same projects.</p>
      <button className="rf-btn rf-btn-primary rf-btn-lg" onClick={onCreate} autoFocus>
        <Icon name="plus" size={16} /> New project
      </button>
      <code className="rf-hint-code">reelforge project create --name "Cafe Brand Story"</code>
    </main>
  );
}
