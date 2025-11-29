# Firebase Studio / IDX dev environment for ESEGAMES game-server
{ pkgs, ... }: {
  channel = "stable-24.05";

  packages = [
    pkgs.nodejs_20
    pkgs.nodePackages.nodemon
    pkgs.git
    pkgs.curl
  ];

  env = {};

  idx = {
    extensions = [
      "google.gemini-cli-vscode-ide-companion"
    ];

    workspace = {
      onCreate = {
        # Install deps only for game-server (client is plain HTML)
        install-server-deps = "cd game-server && npm install";

        default.openFiles = [ ".idx/dev.nix" "README.md" ];
      };

      onStart = {
        # Leave empty to avoid auto-running wrong scripts
      };
    };

    previews = {
      enable = true;
      previews = {
        server = {
          # If your server uses a different script, change "start" to it.
          command = ["npm" "run" "start"];
          manager = "web";
          cwd = "game-server";
          env = { PORT = "$PORT"; };
        };
      };
    };
  };
}
