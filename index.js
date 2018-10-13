'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var readPkgUp = _interopDefault(require('read-pkg-up'));
var mkdirp = _interopDefault(require('mkdirp'));
var mem = _interopDefault(require('mem'));
var fs = _interopDefault(require('fs'));
var path = _interopDefault(require('path'));

const rePrefix = /^\0(?:commonjs-proxy:)?/;

const getPackage = mem(cwd => {
  const info = readPkgUp.sync({ cwd });
  if (info.path == null) {
    return null
  } else {
    info.path = path.dirname(info.path);
    try {
      info.path = fs.realpathSync(info.path);
    } catch (_) {}
    return info
  }
});

const toHtml = data => `<!doctype html>
<html>
<head>
<title>rollup-plugin-analyzer report</title>
<style>
html, body, #container {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
</head>
<body>
<div id="container"></div>
<script src="https://unpkg.com/sunburst-chart"></script>
<script>
(function () {
var colors = Object.create(null)
var min = 96
var max = 256

function color (path) {
  if (colors[path] == null) {
    var m1 = Math.random()
    var m2 = Math.random()
    if (m1 > m2) {
      var temp = m1
      m1 = m2
      m2 = temp
    }
    var r = Math.min(255, min + Math.floor((max - min) * m1))
    var g = Math.min(255, min + Math.floor((max - min) * (m2 - m1)))
    var b = Math.min(255, min + Math.floor((max - min) * (1 - m2)))
    colors[path] = 'rgb(' + r + ',' + g + ',' + b + ')'
  }
  return colors[path]
}

Sunburst()
  .color(function (d) {
    return color(d.path)
  })
  .tooltipContent(function (d, node) {
    return node.value + ' bytes'
  })
  .data(${JSON.stringify(data, null, 2)})(
    document.getElementById('container'))
})()
</script>
</body>
</html>`;

const normalizeId = id => id.replace(rePrefix, '');

const setUpQueue = ({ dependencies, moduleToPackageInfo }) => {
  const queue = [];
  const seen = Object.create(null);
  const enqueue = ids => {
    for (const dependentId of ids) {
      const dependencyIds = dependencies[dependentId];
      if (dependencyIds == null) {
        continue
      }
      for (const id of dependencyIds) {
        const info = moduleToPackageInfo[id];
        if (info != null && info.pkg != null && !seen[info.path]) {
          seen[info.path] = true;
          queue.push(info);
        }
      }
    }
  };
  return {
    queue,
    enqueue
  }
};

const buildPackageNode = (dependentPkg, moduleIds, ctx, ancestors = []) => {
  const {
    sizes,
    moduleToPackageInfo,
    packagePathToModules
  } = ctx;
  const { queue, enqueue } = setUpQueue(ctx);
  enqueue(moduleIds);
  const dependencyPkgs = [];
  while (queue.length > 0) {
    const dependencyPkg = queue.shift();
    if (dependencyPkg.path === dependentPkg.path) {
      const moduleIds = packagePathToModules[dependencyPkg.path];
      if (moduleIds != null) {
        enqueue(moduleIds);
      }
    } else if (!ancestors.includes(dependencyPkg.path) &&
        !dependencyPkgs.some(pkg => pkg.path === dependencyPkg.path)) {
      dependencyPkgs.push(dependencyPkg);
    }
  }
  const children = dependencyPkgs.length > 0
    ? dependencyPkgs.map(pkg => buildPackageNode(
      pkg,
      packagePathToModules[pkg.path] || [],
      ctx,
      [...ancestors, pkg.path]
    ))
    : moduleIds.map(id => {
      const size = sizes[id];
      let realId = id;
      try {
        realId = fs.realpathSync(realId);
      } catch (_) {}
      const name = moduleToPackageInfo[id] != null
        ? path.relative(moduleToPackageInfo[id].path, realId)
        : realId;
      return {
        name: name !== '' ? name : '?',
        value: size,
        path: realId
      }
    });
  return {
    name: dependentPkg.pkg.name,
    children,
    path: dependentPkg.path
  }
};

const getDependenciesAndSizes = modules => {
  const dependencies = Object.create(null);
  const sizes = Object.create(null);
  for (const { id: dependencyVirtualId, dependents, size } of modules) {
    const dependencyId = normalizeId(dependencyVirtualId);
    for (const dependentVirtualId of dependents) {
      const dependentId = normalizeId(dependentVirtualId);
      dependencies[dependentId] = dependencies[dependentId] || [];
      dependencies[dependentId].push(dependencyId);
    }
    sizes[dependencyId] = size;
  }
  return { dependencies, sizes }
};

const getModuleToPackageInfo = (dependencies, rootPackage) => {
  const moduleToPackageInfo = Object.create(null);
  const dependentNames = Object.keys(dependencies);
  for (const dependent of dependentNames) {
    for (const id of [dependent, ...dependencies[dependent]]) {
      if (moduleToPackageInfo[id] == null) {
        moduleToPackageInfo[id] = id.startsWith('/')
          ? getPackage(path.dirname(id))
          : { pkg: { name: id }, path: id };
        if (moduleToPackageInfo[id] == null) {
          moduleToPackageInfo[id] = rootPackage;
        }
      }
    }
  }
  return moduleToPackageInfo
};

const getPackagePathToModules = moduleToPackageInfo => {
  const packagePathToModules = Object.create(null);
  for (const [id, { path: pkgPath }] of Object.entries(moduleToPackageInfo)) {
    if (pkgPath != null) {
      packagePathToModules[pkgPath] = packagePathToModules[pkgPath] || [];
      packagePathToModules[pkgPath].push(id);
    }
  }
  return packagePathToModules
};

const writeHtmlReport = (modules, filePath) => {
  // TODO Detect entry
  const rootPackage = getPackage(process.cwd());
  const { dependencies, sizes } = getDependenciesAndSizes(modules);
  const moduleToPackageInfo = getModuleToPackageInfo(dependencies, rootPackage);
  const packagePathToModules = getPackagePathToModules(moduleToPackageInfo);
  const rootModuleId = Object.keys(dependencies)
    .find(id => !Object.values(dependencies).some(deps => deps.includes(id)));
  const data = buildPackageNode(rootPackage, [rootModuleId], {
    dependencies,
    sizes,
    moduleToPackageInfo,
    packagePathToModules
  });
  const html = toHtml(data);
  mkdirp.sync(path.dirname(filePath));
  fs.writeFileSync(filePath, html, 'utf8');
};

const buf = ' ';
const tab = '  ';
const borderX = `${Array(30).join('-')}\n`;
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Byte'
  let k = 1000;
  let dm = 3;
  let sizes = ['Bytes', 'KB', 'MB', 'GB'];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
};
const shakenPct = (n, o) => Math.max((100 - ((n / o) * 100)).toFixed(2), 0);
const match = (str, check) => str.indexOf(check) !== -1;

const reporter = (analysis, opts) => {
  let formatted = `` +
    `${borderX}` +
    `Rollup File Analysis\n` +
    `${borderX}` +
    `bundle size:    ${formatBytes(analysis.bundleSize)}\n` +
    `original size:  ${formatBytes(analysis.bundleOrigSize)}\n` +
    `code reduction: ${analysis.bundleReduction} %\n` +
    `module count:   ${analysis.moduleCount}\n` +
    `${borderX}`;

  analysis.modules.forEach((m) => {
    formatted += `` +
      `file:           ${buf}${m.id}\n` +
      `bundle space:   ${buf}${m.percent} %\n` +
      `rendered size:  ${buf}${formatBytes(m.size)}\n` +
      `original size:  ${buf}${formatBytes(m.origSize || 'unknown')}\n` +
      `code reduction: ${buf}${m.reduction} %\n` +
      `dependents:     ${buf}${m.dependents.length}\n`;

    let { hideDeps, root, showExports } = opts || {};
    if (!hideDeps) {
      m.dependents.forEach((d) => {
        formatted += `${tab}-${buf}${d.replace(root, '')}\n`;
      });
    }
    if (showExports && m.usedExports && m.unusedExports) {
      formatted += `used exports:   ${buf}${m.usedExports.length}\n`;
      m.usedExports.forEach((e) => {
        formatted += `${tab}-${buf}${e}\n`;
      });
      formatted += `unused exports: ${buf}${m.unusedExports.length}\n`;
      m.unusedExports.forEach((e) => {
        formatted += `${tab}-${buf}${e}\n`;
      });
    }
    formatted += `${borderX}`;
  });

  return formatted
};

const analyzer = (bundle, opts = {}) => {
  let { root, limit, filter } = opts;
  root = root || (process && process.cwd ? process.cwd() : null);
  let deps = {};
  let bundleSize = 0;
  let bundleOrigSize = 0;
  let bundleModules = bundle.modules || [];
  let moduleCount = bundleModules.length;

  let modules = bundleModules.map((m, i) => {
    let {
      id,
      originalLength: origSize,
      renderedLength,
      code,
      usedExports,
      unusedExports
    } = m;
    id = id.replace(root, '');
    let size = renderedLength;
    if (!size && size !== 0) size = code ? Buffer.byteLength(code, 'utf8') : 0;
    bundleSize += size;
    bundleOrigSize += origSize;

    if (Array.isArray(filter) && !filter.some((f) => match(id, f))) return null
    if (typeof filter === 'string' && !match(id, filter)) return null

    m.dependencies.forEach((d) => {
      d = d.replace(root, '');
      deps[d] = deps[d] || [];
      deps[d].push(id);
    });

    return {id, size, origSize, usedExports, unusedExports}
  }).filter((m) => m);

  modules.sort((a, b) => b.size - a.size);
  if (limit || limit === 0) modules = modules.slice(0, limit);
  modules.forEach((m) => {
    m.dependents = deps[m.id] || [];
    m.percent = Math.min(((m.size / bundleSize) * 100).toFixed(2), 100);
    m.reduction = shakenPct(m.size, m.origSize);
  });
  if (typeof filter === 'function') modules = modules.filter(filter);

  let bundleReduction = shakenPct(bundleSize, bundleOrigSize);

  return {bundleSize, bundleOrigSize, bundleReduction, modules, moduleCount}
};

const analyze = (bundle, opts) => new Promise((resolve, reject) => {
  try {
    let analysis = analyzer(bundle, opts);
    return resolve(analysis)
  } catch (ex) { return reject(ex) }
});

const formatted = (bundle, opts) => new Promise((resolve, reject) => {
  try {
    let analysis = analyzer(bundle, opts);
    return resolve(reporter(analysis, opts))
  } catch (ex) { return resolve(ex.toString()) }
});

const plugin = (opts = {}) => {
  let writeTo = opts.writeTo || (opts.stdout ? console.log : console.error);
  let depMap = {};

  let onAnalysis = (analysis) => {
    if (typeof opts.onAnalysis === 'function') opts.onAnalysis(analysis);
    if (typeof opts.htmlReportPath === 'string') writeHtmlReport(analysis.modules, opts.htmlReportPath);
    if (!opts.skipFormatted) writeTo(reporter(analysis, opts));
  };

  let runAnalysis = (out, bundle, isWrite) => new Promise((resolve, reject) => {
    resolve();
    if (out.bundle) bundle = out.bundle;
    let modules = bundle.modules;

    if (Array.isArray(modules)) {
      return analyze({modules}, opts).then(onAnalysis).catch(console.error)
    }

    modules = Object.keys(modules).map((k) => {
      let module = Object.assign(modules[k], depMap[k] || {});
      module.usedExports = module.renderedExports;
      module.unusedExports = module.removedExports;
      return module
    });
    return analyze({modules}, opts).then(onAnalysis).catch(console.error)
  });

  return {
    name: 'rollup-plugin-analyzer',
    transformChunk: (_a, _b, chunk) => new Promise((resolve, reject) => {
      resolve(null);
      if (!chunk || !chunk.orderedModules) return
      chunk.orderedModules.forEach(({id, dependencies}) => {
        depMap[id] = {id, dependencies: dependencies.map((d) => d.id)};
      });
    }),
    generateBundle: runAnalysis,
    ongenerate: runAnalysis
  }
};

exports.reporter = reporter;
exports.analyze = analyze;
exports.formatted = formatted;
exports.plugin = plugin;
