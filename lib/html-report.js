import readPkgUp from 'read-pkg-up'
import mkdirp from 'mkdirp'
import mem from 'mem'
import fs from 'fs'
import path from 'path'

const rePrefix = /^\0(?:commonjs-proxy:)?/

const getPackage = mem(cwd => {
  const info = readPkgUp.sync({ cwd })
  if (info.path == null) {
    return null
  } else {
    info.path = path.dirname(info.path)
    try {
      info.path = fs.realpathSync(info.path)
    } catch (_) {}
    return info
  }
})

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
</html>`

const normalizeId = id => id.replace(rePrefix, '')

const setUpQueue = ({ dependencies, moduleToPackageInfo }) => {
  const queue = []
  const seen = Object.create(null)
  const enqueue = ids => {
    for (const dependentId of ids) {
      const dependencyIds = dependencies[dependentId]
      if (dependencyIds == null) {
        continue
      }
      for (const id of dependencyIds) {
        const info = moduleToPackageInfo[id]
        if (info != null && info.pkg != null && !seen[info.path]) {
          seen[info.path] = true
          queue.push(info)
        }
      }
    }
  }
  return {
    queue,
    enqueue
  }
}

const buildPackageNode = (dependentPkg, moduleIds, ctx, ancestors = []) => {
  const {
    sizes,
    moduleToPackageInfo,
    packagePathToModules
  } = ctx
  const { queue, enqueue } = setUpQueue(ctx)
  enqueue(moduleIds)
  const dependencyPkgs = []
  while (queue.length > 0) {
    const dependencyPkg = queue.shift()
    if (dependencyPkg.path === dependentPkg.path) {
      const moduleIds = packagePathToModules[dependencyPkg.path]
      if (moduleIds != null) {
        enqueue(moduleIds)
      }
    } else if (!ancestors.includes(dependencyPkg.path) &&
        !dependencyPkgs.some(pkg => pkg.path === dependencyPkg.path)) {
      dependencyPkgs.push(dependencyPkg)
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
      const size = sizes[id]
      let realId = id
      try {
        realId = fs.realpathSync(realId)
      } catch (_) {}
      const name = moduleToPackageInfo[id] != null
        ? path.relative(moduleToPackageInfo[id].path, realId)
        : realId
      return {
        name: name !== '' ? name : '?',
        value: size,
        path: realId
      }
    })
  return {
    name: dependentPkg.pkg.name,
    children,
    path: dependentPkg.path
  }
}

const getDependenciesAndSizes = modules => {
  const dependencies = Object.create(null)
  const sizes = Object.create(null)
  for (const { id: dependencyVirtualId, dependents, size } of modules) {
    const dependencyId = normalizeId(dependencyVirtualId)
    for (const dependentVirtualId of dependents) {
      const dependentId = normalizeId(dependentVirtualId)
      dependencies[dependentId] = dependencies[dependentId] || []
      dependencies[dependentId].push(dependencyId)
    }
    sizes[dependencyId] = size
  }
  return { dependencies, sizes }
}

const getModuleToPackageInfo = (dependencies, rootPackage) => {
  const moduleToPackageInfo = Object.create(null)
  const dependentNames = Object.keys(dependencies)
  for (const dependent of dependentNames) {
    for (const id of [dependent, ...dependencies[dependent]]) {
      if (moduleToPackageInfo[id] == null) {
        moduleToPackageInfo[id] = id.startsWith('/')
          ? getPackage(path.dirname(id))
          : { pkg: { name: id }, path: id }
        if (moduleToPackageInfo[id] == null) {
          moduleToPackageInfo[id] = rootPackage
        }
      }
    }
  }
  return moduleToPackageInfo
}

const getPackagePathToModules = moduleToPackageInfo => {
  const packagePathToModules = Object.create(null)
  for (const [id, { path: pkgPath }] of Object.entries(moduleToPackageInfo)) {
    if (pkgPath != null) {
      packagePathToModules[pkgPath] = packagePathToModules[pkgPath] || []
      packagePathToModules[pkgPath].push(id)
    }
  }
  return packagePathToModules
}

export const writeHtmlReport = (modules, filePath) => {
  // TODO Detect entry
  const rootPackage = getPackage(process.cwd())
  const { dependencies, sizes } = getDependenciesAndSizes(modules)
  const moduleToPackageInfo = getModuleToPackageInfo(dependencies, rootPackage)
  const packagePathToModules = getPackagePathToModules(moduleToPackageInfo)
  const rootModuleId = Object.keys(dependencies)
    .find(id => !Object.values(dependencies).some(deps => deps.includes(id)))
  const data = buildPackageNode(rootPackage, [rootModuleId], {
    dependencies,
    sizes,
    moduleToPackageInfo,
    packagePathToModules
  })
  const html = toHtml(data)
  mkdirp.sync(path.dirname(filePath))
  fs.writeFileSync(filePath, html, 'utf8')
}
