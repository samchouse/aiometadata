{ pkgs, ... }:
{
  packages = [ pkgs.git ];
  languages.javascript.enable = true;
}
