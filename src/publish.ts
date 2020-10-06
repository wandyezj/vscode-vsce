import * as fs from 'fs';
import { ExtensionQueryFlags, PublishedExtension } from 'azure-devops-node-api/interfaces/GalleryInterfaces';
import { pack, readManifest, IPackage, isWebKind, isSupportedWebExtension } from './package';
import * as tmp from 'tmp';
import { getPublisher } from './store';
import { getGalleryAPI, read, getPublishedUrl, log, getPublicGalleryAPI, getHubUrl } from './util';
import { Manifest } from './manifest';
import * as denodeify from 'denodeify';
import * as yauzl from 'yauzl';
import * as semver from 'semver';
import * as cp from 'child_process';

const exec = denodeify<string, { cwd?: string; env?: any }, { stdout: string; stderr: string }>(
	cp.exec as any,
	(err, stdout, stderr) => [err, { stdout, stderr }]
);
const tmpName = denodeify<string>(tmp.tmpName);

function readManifestFromPackage(packagePath: string): Promise<Manifest> {
	return new Promise<Manifest>((c, e) => {
		yauzl.open(packagePath, (err, zipfile) => {
			if (err) {
				return e(err);
			}

			const onEnd = () => e(new Error('Manifest not found'));
			zipfile.once('end', onEnd);

			zipfile.on('entry', entry => {
				if (!/^extension\/package\.json$/i.test(entry.fileName)) {
					return;
				}

				zipfile.removeListener('end', onEnd);

				zipfile.openReadStream(entry, (err, stream) => {
					if (err) {
						return e(err);
					}

					const buffers = [];
					stream.on('data', buffer => buffers.push(buffer));
					stream.once('error', e);
					stream.once('end', () => {
						try {
							c(JSON.parse(Buffer.concat(buffers).toString('utf8')));
						} catch (err) {
							e(err);
						}
					});
				});
			});
		});
	});
}

async function _publish(packagePath: string, pat: string, manifest: Manifest): Promise<void> {
	const api = await getGalleryAPI(pat);

	const packageStream = fs.createReadStream(packagePath);

	const name = `${manifest.publisher}.${manifest.name}`;
	const fullName = `${name}@${manifest.version}`;
	console.log(`Publishing ${fullName}...`);

	let extension: PublishedExtension | null = null;

	try {
		try {
			extension = await api.getExtension(
				null,
				manifest.publisher,
				manifest.name,
				null,
				ExtensionQueryFlags.IncludeVersions
			);
		} catch (err) {
			if (err.statusCode !== 404) {
				throw err;
			}
		}

		if (extension && extension.versions.some(v => v.version === manifest.version)) {
			throw new Error(`${fullName} already exists. Version number cannot be the same.`);
		}

		if (extension) {
			try {
				await api.updateExtension(undefined, packageStream, manifest.publisher, manifest.name);
			} catch (err) {
				if (err.statusCode === 409) {
					throw new Error(`${fullName} already exists.`);
				} else {
					throw err;
				}
			}
		} else {
			await api.createExtension(undefined, packageStream);
		}
	} catch (err) {
		const message = (err && err.message) || '';

		if (/Invalid Resource/.test(message)) {
			err.message = `${err.message}\n\nYou're likely using an expired Personal Access Token, please get a new PAT.\nMore info: https://aka.ms/vscodepat`;
		}

		throw err;
	}

	log.info(`Extension URL (might take a few minutes): ${getPublishedUrl(name)}`);
	log.info(`Hub URL: ${getHubUrl(manifest.publisher, manifest.name)}`);
	log.done(`Published ${fullName}.`);
}

export interface IPublishOptions {
	packagePath?: string;
	version?: string;
	commitMessage?: string;
	cwd?: string;
	pat?: string;
	githubBranch?: string;
	baseContentUrl?: string;
	baseImagesUrl?: string;
	useYarn?: boolean;
	noVerify?: boolean;
	ignoreFile?: string;
	web?: boolean;
}

async function versionBump(cwd: string = process.cwd(), version?: string, commitMessage?: string): Promise<void> {
	if (!version) {
		return Promise.resolve(null);
	}

	const manifest = await readManifest(cwd);

	if (manifest.version === version) {
		return null;
	}

	switch (version) {
		case 'major':
		case 'minor':
		case 'patch':
			break;
		case 'premajor':
		case 'preminor':
		case 'prepatch':
		case 'prerelease':
		case 'from-git':
			return Promise.reject(`Not supported: ${version}`);
		default:
			if (!semver.valid(version)) {
				return Promise.reject(`Invalid version ${version}`);
			}
	}

	let command = `npm version ${version}`;

	if (commitMessage) {
		command = `${command} -m "${commitMessage}"`;
	}

	try {
		// call `npm version` to do our dirty work
		const { stdout, stderr } = await exec(command, { cwd });
		process.stdout.write(stdout);
		process.stderr.write(stderr);
		return null;
	} catch (err) {
		throw err.message;
	}
}

export function publish(options: IPublishOptions = {}): Promise<any> {
	let promise: Promise<IPackage>;

	if (options.packagePath) {
		if (options.version) {
			return Promise.reject(`Not supported: packagePath and version.`);
		}
		if (options.web) {
			return Promise.reject(`Not supported: packagePath and web.`);
		}

		promise = readManifestFromPackage(options.packagePath).then(manifest => ({
			manifest,
			packagePath: options.packagePath,
		}));
	} else {
		const cwd = options.cwd;
		const githubBranch = options.githubBranch;
		const baseContentUrl = options.baseContentUrl;
		const baseImagesUrl = options.baseImagesUrl;
		const useYarn = options.useYarn;
		const ignoreFile = options.ignoreFile;
		const web = options.web;

		promise = versionBump(options.cwd, options.version, options.commitMessage)
			.then(() => tmpName())
			.then(packagePath =>
				pack({ packagePath, cwd, githubBranch, baseContentUrl, baseImagesUrl, useYarn, ignoreFile, web })
			);
	}

	return promise.then(async ({ manifest, packagePath }) => {
		if (!options.noVerify && manifest.enableProposedApi) {
			throw new Error("Extensions using proposed API (enableProposedApi: true) can't be published to the Marketplace");
		}

		if (options.web) {
			if (!isWebKind(manifest)) {
				throw new Error("Extensions which are not web kind can't be published to the Marketpalce as a web extension");
			}
			const extensionsReport = await getPublicGalleryAPI().getExtensionsReport();
			if (!isSupportedWebExtension(manifest, extensionsReport)) {
				throw new Error("Extensions which are not supported can't be published to the Marketpalce as a web extension");
			}
		}

		const patPromise = options.pat ? Promise.resolve(options.pat) : getPublisher(manifest.publisher).then(p => p.pat);

		return patPromise.then(pat => _publish(packagePath, pat, manifest));
	});
}

export interface IUnpublishOptions extends IPublishOptions {
	id?: string;
	force?: boolean;
}

export async function unpublish(options: IUnpublishOptions = {}): Promise<any> {
	let publisher: string, name: string;

	if (options.id) {
		[publisher, name] = options.id.split('.');
	} else {
		const manifest = await readManifest(options.cwd);
		publisher = manifest.publisher;
		name = manifest.name;
	}

	const fullName = `${publisher}.${name}`;

	if (!options.force) {
		const answer = await read(`This will FOREVER delete '${fullName}'! Are you sure? [y/N] `);

		if (!/^y$/i.test(answer)) {
			throw new Error('Aborted');
		}
	}

	const pat = options.pat || (await getPublisher(publisher).then(p => p.pat));
	const api = await getGalleryAPI(pat);

	await api.deleteExtension(publisher, name);
	log.done(`Deleted extension: ${fullName}!`);
}
