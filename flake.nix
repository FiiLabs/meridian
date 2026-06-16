{
  description = "Meridian – Local Anthropic API powered by your Claude Max subscription";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix/2.0.8";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      bun2nix,
    }:
    let
      eachSystem = nixpkgs.lib.genAttrs (import systems);
      pkgsFor = eachSystem (
        system:
        import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        }
      );
    in
    {
      packages = eachSystem (system: {
        meridian = pkgsFor.${system}.callPackage ./nix/package.nix { };
        default = self.packages.${system}.meridian;
      });

      overlays.default = final: _: {
        meridian = self.packages.${final.stdenv.hostPlatform.system}.meridian;
      };

      homeManagerModules.default = import ./nix/hm-module.nix { meridianPackages = self.packages; };
    };
}
