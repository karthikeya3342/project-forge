import docker
import docker.errors
from pathlib import Path


MAX_CONTAINER_TIMEOUT = 60  # seconds


class DockerRunner:
    def __init__(self, workspace_path: str):
        self.workspace_path = str(Path(workspace_path).resolve())
        self.client = docker.from_env()

    def run_command(self, command: str, image: str = "python:3.11-slim") -> dict:
        """
        Runs command inside Docker with workspace bind-mounted to /workspace.
        Container working_dir is locked to /workspace — no host escape possible.
        """
        try:
            container = self.client.containers.run(
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
            return {"success": True, "output": output, "error": None}

        except docker.errors.ContainerError as e:
            return {"success": False, "output": "", "error": str(e.stderr.decode("utf-8"))}
        except docker.errors.ImageNotFound:
            return {"success": False, "output": "", "error": f"Image '{image}' not found"}
        except Exception as e:
            return {"success": False, "output": "", "error": str(e)}

    def write_file(self, relative_path: str, content: str):
        """Write file into workspace. Path must be relative — no escape."""
        target = Path(self.workspace_path) / Path(relative_path).relative_to("/")
        target = Path(self.workspace_path) / relative_path.lstrip("/").lstrip("\\")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
