"use strict";

// minimatch@5 and minimatch@9 expect brace-expansion's historical callable
// CommonJS export. brace-expansion@5 exposes a named `expand` export instead.
// Preserve the old call contract while using the remediated v5 implementation.
module.exports = require("./dist/commonjs/index.js").expand;
