// Font files imported by the motion-graphics compositions resolve to a URL in both bundlers.
declare module "*.ttf" {
  const url: string;
  export default url;
}
