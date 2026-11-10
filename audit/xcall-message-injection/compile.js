const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = '/home/user/audit/xcall-multi/contracts/evm';
const POC = '/home/user/audit/poc';
const NODE = path.join(POC, 'node_modules');

const remaps = [
  ['@xcall/utils/', path.join(ROOT, 'library/utils/')],
  ['@xcall/contracts/', path.join(ROOT, 'contracts/')],
  ['@iconfoundation/xcall-solidity-library/', path.join(ROOT, 'library/xcall/')],
  ['openzeppelin-contracts-upgradeable/', path.join(NODE, '@openzeppelin/contracts-upgradeable/')],
  ['openzeppelin-contracts-upgradeable/contracts/', path.join(NODE, '@openzeppelin/contracts-upgradeable/')],
  ['openzeppelin-contracts/', path.join(NODE, '@openzeppelin/contracts/')],
  ['openzeppelin-contracts/contracts/', path.join(NODE, '@openzeppelin/contracts/')],
  ['@openzeppelin/contracts-upgradeable/', path.join(NODE, '@openzeppelin/contracts-upgradeable/')],
  ['@openzeppelin/contracts/', path.join(NODE, '@openzeppelin/contracts/')],
  ['forge-std/', path.join(ROOT, 'lib/forge-std/src/')],
];

function resolve(importPath) {
  for (const [prefix, base] of remaps) {
    if (importPath.startsWith(prefix)) {
      const p = path.join(base, importPath.slice(prefix.length));
      if (fs.existsSync(p)) return { contents: fs.readFileSync(p, 'utf8') };
    }
  }
  for (const base of [ROOT, path.join(ROOT, 'contracts'), path.join(ROOT, 'library'), path.join(ROOT, 'src')]) {
    const p = path.join(base, importPath);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return { contents: fs.readFileSync(p, 'utf8') };
  }
  return { error: 'not found: ' + importPath };
}

const sources = {
  'contracts/xcall/CallService.sol': { content: fs.readFileSync(path.join(ROOT, 'contracts/xcall/CallService.sol'), 'utf8') },
  'contracts/PoC.sol': { content: fs.readFileSync(path.join(POC, 'src/PoC.sol'), 'utf8') },
};

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: resolve }));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) {
  console.error(errs.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}
const pick = (file, name) => {
  const c = out.contracts[file][name];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
};
const artifacts = {
  CallService: pick('contracts/xcall/CallService.sol', 'CallService'),
  ForgeHelper: pick('contracts/PoC.sol', 'ForgeHelper'),
  Vault: pick('contracts/PoC.sol', 'Vault'),
  AttackerConn: pick('contracts/PoC.sol', 'AttackerConn'),
};
fs.writeFileSync(path.join(POC, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
console.log('compiled:', Object.keys(artifacts).map(k => k + ':' + (artifacts[k].bytecode.length/2) + 'B').join(' '));
