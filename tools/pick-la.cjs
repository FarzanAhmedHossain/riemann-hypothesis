// Pick rows from a `lookahead.mjs --dry` output by index, assign trees, add family hints, mark processed.
//   node tools/pick-la.cjs runs/la-all.json <firstTreeNumber> <idx,idx,...> > runs/la-args.json
const fs = require('fs'), path = require('path');
const [, , inFile, firstTree, idxs] = process.argv;
const a = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const pick = idxs.split(',').map(Number);
const rows = pick.map((i, k) => ({ ...a.rows[i], tree: `w${+firstTree + k}`, createTree: !fs.existsSync(path.join(__dirname, '..', 'wt', `w${+firstTree + k}`)) }));
// Family hints: rows whose session-line texts share a distinctive fragment are probably the same bundling problem.
const FAMS = [
  [/SigmaCompactSpace \(GA E 0\)/, 'This haveI was added by OUR merged PR #1030 (Bundle0003, 13:07 UTC) and now fails to synthesize in the look-ahead build: sigmaCompactSpace_of_locallyCompact_secondCountable needs LocallyCompactSpace and SecondCountableTopology for GA E 0, one of which is not found here. Find which (newinst --grep \'LocallyCompact|SecondCountable|GA\'), and supply it the way the section\'s other haveIs or merged precedents do (#1006 did the same for GA E a / GA E b in Bundle0531). Fixing our own follow-up error is a priority.'],
  [/Finite \(GA E 0\) := Finite\.of_subsingleton/, 'Sibling files LieInvariants/InvariantOfLieOneLEqZero, AffineLieInvariants/InvariantOfLieOneLEqZero and BlockDecomposition/Bundle0687 have the identical `haveI : Finite (GA E 0) := Finite.of_subsingleton` failure (other agents fix those in parallel): the Subsingleton (GA E 0) instance is not found after bundling. Find the instance the original used and why it is hidden or shadowed (resolve / newinst --grep \'Subsingleton|Unique|GA\'), then supply it explicitly.'],
  [/integral_integral_swap/, 'Sibling rows (InertiaEigenvalues Bundle0826, DivisorProofs Bundle1736, CompactSupportTwists Bundle0008) fail at `integral_integral_swap`: it needs SFinite for both measures, which bundling hides. Merged precedents #1006 and our #1030 supplied explicit `haveI : SFinite μ := MeasureTheory.instSFiniteOfSigmaFinite` (plus SigmaFinite / SigmaCompactSpace when needed).'],
  [/phiA/, 'Sibling rows (DivisorProofs Bundle1636 and ZetaIntegralLeftTranslatePrimitiveFrames) fail with "Failed to rewrite using equation theorems for phiA": `phiA` probably resolves to a different, bundled declaration with another definition. Resolve phiA on the section\'s original and qualify it (playbook Pattern 1).'],
  [/let : OfNat \(Over\.mk/, 'Sibling rows with the same `let : OfNat (Over.mk ...) 1 := ...` failure are being fixed in parallel by other agents in other files; find the common root cause (which instance or name became visible through bundling) and fix it the same way here.'],
  [/PairDom\.isFundamentalDomain_range_prodMap|domOne_measure|lintegral_lintegral_swap|IsMulRightInvariant/, 'Several sibling rows fail to synthesize measure-theory instances (SFinite / SigmaFinite / IsFundamentalDomain inputs) after bundling; known culprits: PI.WSF.instMeasurableSpaceMat, PI.WSF.instBorelSpaceMat, DoubleCosetMeasures.instMeasMat (fix precedent: `attribute [-instance] <culprit> in` or a file-level attribute line placed after the opens). Check with closure --has whether a culprit is visible here but not in the original.'],
  [/w\.under \(𝓞 ℚ\) = v → H\.KAt w g/, 'The sibling file (WhittakerHecke Bundle0027 / ExistsWhittakerHeckeEigenvaluesAtSplitPlace) has the same "overloaded, errors" statement: an ambiguous name in the statement; resolve each candidate and qualify to the original\'s meaning without changing the statement.'],
  [/_root_\.bumpEx/, 'This file was fixed by our own PR #964 (qualified a private `bumpEx` as `_root_.bumpEx`); the look-ahead now reports a later error near it. Check whether `_root_.bumpEx` resolves to the declaration the original meant (private declarations in another bundled section are not visible) and fix correctly.'],
  [/subset_tsupport _ hφ0|quotIntegral_prod/, 'This file was fixed earlier by our own PR #974; the look-ahead now reports a later error. Find the instance the original found and why bundling hides or shadows it.'],
];
for (const r of rows) for (const [re, h] of FAMS) if (re.test(r.error)) { r.hint += ' ' + h; break; }
for (const r of rows) fs.appendFileSync(path.join(__dirname, '..', 'runs', 'processed.txt'), r.file + '|*\n');
process.stdout.write(JSON.stringify({ home: a.home, listTime: a.listTime, rows }));
process.stderr.write(rows.map(r => `${r.tree} ${r.file.split('/').slice(-2).join('/')}`).join('\n') + '\n');
