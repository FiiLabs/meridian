{
  description = "Meridian – Local Anthropic API powered by your Claude Max subscription";

  inputs = {
    bun2nix = {
      url = "github:nix-community/bun2nix/2.0.8";
      inputs = {
        flake-parts.follows = "flake-parts";
        nixpkgs.follows = "nixpkgs";
        systems.follows = "systems";
      };
    };
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    inputs@{
      bun2nix,
      flake-parts,
      nixpkgs,
      systems,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } (
      {
        moduleWithSystem,
        self,
        withSystem,
        ...
      }:
      {
        systems = import systems;

        perSystem =
          {
            config,
            pkgs,
            system,
            ...
          }:
          {
            _module.args.pkgs = import nixpkgs {
              inherit system;
              overlays = [ bun2nix.overlays.default ];
            };

            packages = {
              default = config.packages.meridian;
              meridian = pkgs.callPackage ./nix/package.nix { };
            };
          };

        flake = {
          overlays = {
            default = self.overlays.meridian;
            meridian =
              _: prev:
              withSystem prev.stdenv.hostPlatform.system ({ self', ... }: { inherit (self'.packages) meridian; });
          };

          homeManagerModules = {
            default = self.homeManagerModules.meridian;
            meridian = moduleWithSystem (
              { self', ... }: import ./nix/hm-module.nix { inherit (self'.packages) meridian; }
            );
          };
        };
      }
    );
}
