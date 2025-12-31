export default {
  "*": async (files) => {
    return [`prettier -u -c ${files.join(" ")}`];
  },
  "*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}": async (files) => {
    return [`eslint --no-warn-ignored ${files.join(" ")}`];
  },
  "package.json": async (files) => {
    return [`pnpm sort-package-json -c ${files.join(" ")}`];
  },
};
