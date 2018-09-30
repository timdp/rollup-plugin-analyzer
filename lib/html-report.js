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
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/4.13.0/d3.min.js"></script>
<script src="https://unpkg.com/sunburst-chart"></script>
<script>
var scheme = d3.scaleOrdinal(d3.schemeCategory20)
Sunburst()
  .color(function (d) {
    return scheme(d.name)
  })
  .tooltipContent(function (d, node) {
    return node.value + ' bytes'
  })
  .data(${JSON.stringify(data, null, 2)})(
    document.getElementById('container'))
</script>
</body>
</html>`

const normalizeId = id => id.replace(rePrefix, '')

const buildPackageNode = (pkgName, moduleIds, ctx) => {
  const {
    dependencies,
    sizes,
    moduleToPackageInfo,
    packagePathToModules
  } = ctx
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
        console.log('info', id, info)
        if (info != null && info.pkg != null && !seen[info.path]) {
          seen[info.path] = true
          console.log('enqueue', info.path)
          queue.push(info)
        }
      }
    }
  }
  console.log('modules', moduleIds)
  enqueue(moduleIds)
  const pkgInfos = []
  while (queue.length > 0) {
    const pkgInfo = queue.shift()
    if (pkgInfo.pkg.name !== pkgName) {
      pkgInfos.push(pkgInfo)
    } else {
      const moduleIds = packagePathToModules[pkgInfo.path]
      if (moduleIds != null) {
        enqueue(moduleIds)
      }
    }
  }
  const pkgs = []
  for (const pkgInfo of pkgInfos) {
    if (!pkgs.some(info => pkgInfo.path === info.path)) {
      pkgs.push(pkgInfo)
    }
  }
  console.log('pkgs', pkgs)
  const children = pkgs.length > 0
    ? pkgs.map(({ pkg, path: pkgPath }) =>
      buildPackageNode(pkg.name, packagePathToModules[pkgPath] || [], ctx))
    : moduleIds.map(id => ({
      name: moduleToPackageInfo[id] != null
        ? path.relative(moduleToPackageInfo[id].path, id)
        : id,
      value: sizes[id]
    }))
  return {
    name: pkgName,
    children
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

const getModuleToPackageInfo = (dependencies, rootPackagePath) => {
  const moduleToPackageInfo = Object.create(null)
  const dependentNames = Object.keys(dependencies)
  for (const dependent of dependentNames) {
    for (let id of [dependent, ...dependencies[dependent]]) {
      if (moduleToPackageInfo[id] == null) {
        let info = getPackage(path.dirname(id))
        if (info == null && id.startsWith('/')) {
          id = path.join(rootPackagePath, id.substr(1))
          info = getPackage(path.dirname(id))
        }
        if (info != null && info.path !== rootPackagePath) {
          moduleToPackageInfo[id] = info
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
  const { path: rootPackagePath } = getPackage(process.cwd())
  const { dependencies, sizes } = getDependenciesAndSizes(modules)
  const moduleToPackageInfo = getModuleToPackageInfo(dependencies, rootPackagePath)
  const packagePathToModules = getPackagePathToModules(moduleToPackageInfo)
  const rootModuleIds = Object.keys(dependencies)
    .filter(id => !Object.values(dependencies).some(deps => deps.includes(id)))
  const data = buildPackageNode('root', rootModuleIds, {
    dependencies,
    sizes,
    moduleToPackageInfo,
    packagePathToModules
  })
  const html = toHtml(data)
  mkdirp.sync(path.dirname(filePath))
  fs.writeFileSync(filePath, html, 'utf8')
}
