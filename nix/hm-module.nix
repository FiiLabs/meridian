{ meridian }:
{ config, lib, ... }:
let
  cfg = config.services.meridian;
  pkg = cfg.package;
in
{
  options.services.meridian = {
    enable = lib.mkEnableOption "the Meridian proxy service";

    package = lib.mkOption {
      type = lib.types.package;
      default = meridian;
      description = "The Meridian package to use.";
    };

    settings = {
      port = lib.mkOption {
        type = lib.types.port;
        default = 3456;
        description = "Port to listen on.";
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Host to bind to.";
      };

      idleTimeoutSeconds = lib.mkOption {
        type = lib.types.int;
        default = 120;
        description = "HTTP keep-alive idle timeout in seconds.";
      };

      passthrough = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = "Forward tool calls to client instead of executing. Null lets Meridian auto-detect.";
      };

      defaultAgent = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default adapter for unrecognized agents (opencode, forgecode, pi, crush, droid, passthrough).";
      };

      sonnetModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Sonnet context tier: 'sonnet' (200k) or 'sonnet[1m]' (1M, requires Extra Usage).";
      };

      telemetry = {
        persist = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Enable SQLite telemetry persistence.";
        };

        retentionDays = lib.mkOption {
          type = lib.types.nullOr lib.types.int;
          default = null;
          description = "Days to retain telemetry data before cleanup.";
        };
      };
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra environment variables passed to the Meridian service.";
    };

    opencode.pluginPath = lib.mkOption {
      type = lib.types.str;
      default = "${pkg}/lib/meridian/plugin/meridian.ts";
      readOnly = true;
      description = "Nix store path to the OpenCode plugin file. Use this to reference the plugin in your OpenCode config.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.meridian = {
      Unit.Description = "Meridian - Local Anthropic API proxy";

      Service = {
        Type = "exec";
        ExecStart = lib.getExe pkg;
        Restart = "on-failure";
        RestartSec = 5;

        Environment =
          let
            env =
              lib.filterAttrs (_: v: v != null) {
                MERIDIAN_DEFAULT_AGENT = cfg.settings.defaultAgent;
                MERIDIAN_HOST = cfg.settings.host;
                MERIDIAN_IDLE_TIMEOUT_SECONDS = cfg.settings.idleTimeoutSeconds;
                MERIDIAN_PASSTHROUGH = lib.mapNullable (b: if b then "1" else "0") cfg.settings.passthrough;
                MERIDIAN_PORT = cfg.settings.port;
                MERIDIAN_SONNET_MODEL = cfg.settings.sonnetModel;
                MERIDIAN_TELEMETRY_PERSIST = if cfg.settings.telemetry.persist then "1" else null;
                MERIDIAN_TELEMETRY_RETENTION_DAYS = cfg.settings.telemetry.retentionDays;
              }
              // cfg.environment;
          in
          lib.mapAttrsToList (k: v: "${k}=${toString v}") env;
      };

      Install.WantedBy = [ "default.target" ];
    };
  };
}
