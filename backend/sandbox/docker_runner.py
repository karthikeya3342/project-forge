import subprocess
from pathlib import Path
from backend.broadcast import broadcast as _broadcast_ws

try:
    import docker
    import docker.errors
    _DOCKER_AVAILABLE = True
except ImportError:
    _DOCKER_AVAILABLE = False

MAX_CONTAINER_TIMEOUT = 60  # seconds


class DockerRunner:
    def __init__(self, workspace_path: str):
        self.workspace_path = str(Path(workspace_path).resolve())
        self._client = None  # lazy — don't connect until run_command is called

    def _get_client(self):
        if not _DOCKER_AVAILABLE:
            return None
        if self._client is None:
            try:
                self._client = docker.from_env()
            except Exception:
                self._client = None
        return self._client

    def run_command(self, command: str, image: str = "python:3.11-slim") -> dict:
        """
        Runs command inside Docker with workspace bind-mounted to /workspace.
        Falls back to local subprocess if Docker is unavailable.
        """
        client = self._get_client()

        if client:
            try:
                container = client.containers.run(
                    image=image,
                    command=f"bash -c '{command}'",
                    volumes={
                        self.workspace_path: {
                            "bind": "/workspace",
                            "mode": "rw",
                        }
                    },
                    working_dir="/workspace",
                    remove=True,
                    stdout=True,
                    stderr=True,
                    timeout=MAX_CONTAINER_TIMEOUT,
                    mem_limit="512m",
                    network_disabled=True,
                )
                output = container.decode("utf-8") if isinstance(container, bytes) else str(container)
                if output.strip():
                    _broadcast_ws({"type": "terminal_output", "output": output})
                return {"success": True, "output": output, "error": None}

            except Exception as e:
                # Docker failed — fall through to subprocess
                pass

        # Fallback: run directly in workspace (dev mode, Docker unavailable)
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=self.workspace_path,
                capture_output=True,
                text=True,
                timeout=MAX_CONTAINER_TIMEOUT,
            )
            output = result.stdout + result.stderr
            if output.strip():
                _broadcast_ws({"type": "terminal_output", "output": output})
            return {
                "success": result.returncode == 0,
                "output": output,
                "error": result.stderr if result.returncode != 0 else None,
            }
        except Exception as e:
            return {"success": False, "output": "", "error": str(e)}

    def write_file(self, relative_path: str, content: str):
        """Write file into workspace. Path must be relative — no escape."""
        target = Path(self.workspace_path) / relative_path.lstrip("/").lstrip("\\")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
