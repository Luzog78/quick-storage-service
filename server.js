const rateLimit				= require('express-rate-limit');
const jwt					= require('jsonwebtoken');
const fs					= require('fs/promises');
const express				= require('express');
const dotenv				= require('dotenv');
const multer				= require('multer');
const {v4 : uuidv4}			= require('uuid');
const path					= require('path');


dotenv.config();


const ENVIRONMENT = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = process.env.STORAGE_PUBLIC || 'storage/public';
const PRIVATE_DIR = process.env.STORAGE_PRIVATE || 'storage/private';
const TOKEN = process.env.TOKEN ?? 'null';


const upload = multer({
	storage: multer.diskStorage({
		destination: (req, file, cb) => {
			if (req.uploadConf?.dirname !== undefined) {
				cb(null, req.uploadConf.dirname);
			} else {
				const err = new Error('Missing upload directory');
				err.code = 'MISSING_CONFIG';
				cb(err);
			}
		},
		filename: (req, file, cb) => {
			if (req.uploadConf !== undefined) {
				if (req.uploadConf.filename)
					cb(null, req.uploadConf.filename);
				else
					cb(null, uuidv4() + path.extname(file.originalname));
			} else {
				const err = new Error('Missing upload filename');
				err.code = 'MISSING_CONFIG';
				cb(err);
			}
		}
	}),
	limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});


const initStorage = async () => {
	await fs.mkdir(PUBLIC_DIR, { recursive: true });
	await fs.mkdir(PRIVATE_DIR, { recursive: true });
};


const getSafePath = (baseDir, reqPath) => {
	const safeBase = path.resolve(baseDir);
	const targetPath = path.resolve(safeBase, reqPath || '');
	if (!targetPath.startsWith(safeBase)) {
		const err = new Error('Invalid path: Directory traversal detected');
		err.status = 400;
		throw err;
	}
	return targetPath;
};


const asyncHandler = fn => (req, res, next) => {
	try {
		Promise.resolve(fn(req, res, next)).catch(next);
	} catch (err) {
		next(err);
	}
};


const extractAuth = (req, res, next) => {
	const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
		|| (req.query?.auth || '').trim();

	req.isAuthenticated = false;
	req.isRoot = false;
	req.authData = null;

	if (token === TOKEN) {
		req.isAuthenticated = true;
		req.isRoot = true;
	} else {
		try {
			const decoded = jwt.verify(token, TOKEN);
			req.isAuthenticated = true;
			req.authData = decoded;
		} catch (err) {
		}
	}
	next();
};


const requireAuth = (req, res, next) => {
	if (!req.isAuthenticated)
		return res.status(401).json({ ok: false, error: 'Unauthorized' });
	next();
};


const requireRoot = (req, res, next) => {
	if (!req.isRoot)
		return res.status(401).json({ ok: false, error: 'Unauthorized' });
	next();
}


const app = express();

app.set('trust proxy', '127.0.0.1');
app.use(extractAuth);
app.use(rateLimit({
	// 90000 req / 30 min = 5 req/s
	windowMs: 1800 * 1000,
	max: 90000,
	standardHeaders: true,
	legacyHeaders: false,
	ipv6Subnet: 48,
	statusCode: 429,
	skipSuccessfulRequests: false,
	skipFailedRequests: false,
	message: { ok: false, error: 'Too many requests, please try again later.' },
	skip: (req, res) => req.isAuthenticated,
}), (req, res, next) => {
	if (req.isAuthenticated)
		return next();

	const hits = req.rateLimit?.hits || 0;
	if (hits <= 2000)
		return next();
	return setTimeout(next, Math.min(Math.floor(hits / 2000) * 100, 1000));
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());


app.all('/', (req, res) => {
	res.json({ ok: true, message: 'Welcome to the Storage Service API' });
});


app.head(/^\/p(\/(.*))?/, asyncHandler(async (req, res) => {
	const targetPath = getSafePath(PUBLIC_DIR, req.params[1]);
	const stats = await fs.stat(targetPath); // Throws ENOENT if not found

	if (stats.isDirectory()) {
		if (!req.isAuthenticated)
			return res.status(404).end();
		return res.status(200).end();
	}

	res.set('Content-Length', stats.size);
	res.set('Last-Modified', stats.mtime.toUTCString());
	res.status(200).end();
}));


app.head(/^\/s(\/(.*))?/, requireAuth, asyncHandler(async (req, res) => {
	const targetPath = getSafePath(PRIVATE_DIR, req.params[1]);
	const stats = await fs.stat(targetPath); // Throws ENOENT if not found

	if (stats.isDirectory())
		return res.status(200).end();

	res.set('Content-Length', stats.size);
	res.set('Last-Modified', stats.mtime.toUTCString());
	res.status(200).end();
}));


app.get(/^\/p(\/(.*))?/, asyncHandler(async (req, res) => {
	const targetPath = getSafePath(PUBLIC_DIR, req.params[1]);
	const stats = await fs.stat(targetPath); // Throws ENOENT if not found
	const download = ['true', '1', 'yes'].includes(String(req.query?.download).toLowerCase());

	if (stats.isDirectory()) {
		if (!req.isAuthenticated)
			return res.status(404).json({ ok: false, error: 'File or directory not found' });
		const items = await fs.readdir(targetPath, { withFileTypes: true });
		return res.json({
			ok: true,
			content: items.map(item => ([ item.name, item.isDirectory() ? 1 : 0 ]))
		});
	}

	if (download)
		return res.download(targetPath, path.basename(targetPath));
	res.sendFile(targetPath);
}));


app.get(/^\/s(\/(.*))?/, requireAuth, asyncHandler(async (req, res) => {
	const targetPath = getSafePath(PRIVATE_DIR, req.params[1]);
	const stats = await fs.stat(targetPath); // Throws ENOENT if not found
	const download = ['true', '1', 'yes'].includes(String(req.query?.download).toLowerCase());

	if (stats.isDirectory()) {
		const items = await fs.readdir(targetPath, { withFileTypes: true });
		return res.json({
			ok: true,
			content: items.map(item => ([ item.name, item.isDirectory() ? 1 : 0 ]))
		});
	}

	if (download)
		return res.download(targetPath, path.basename(targetPath));
	res.sendFile(targetPath);
}));


const handleUpload = async (req, res, next, baseDir) => {
	const targetPath = getSafePath(baseDir, req.params[1]);
	const fileType = req.query?.type || 'file';
	const overwrite = ['true', '1', 'yes'].includes(String(req.query?.overwrite).toLowerCase());

	if (fileType === 'folder') {
		await fs.mkdir(targetPath, { recursive: true });
		return res.json({ ok: true, message: 'Folder created successfully' });
	} else if (fileType === 'files') {
		await fs.mkdir(targetPath, { recursive: true });
		req.uploadConf = {
			dirname: targetPath,
			filename: undefined,
			query: [{ name: 'files', maxCount: 100 }],
		};
	} else {
		if (!overwrite) {
			try {
				await fs.stat(targetPath);

				const err = new Error();
				err.code = 'FILE_EXISTS';
				return next(err);
			} catch (err) {
			}
		}

		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		req.uploadConf = {
			dirname: path.dirname(targetPath),
			filename: path.basename(targetPath),
			query: [{ name: 'file', maxCount: 1 }],
		};
	}

	upload.fields(req.uploadConf.query)(req, res, err => {
		if (err) {
			if (err instanceof multer.MulterError)
				return res.status(400).json({ ok: false, error: err.message });
			return next(err);
		}

		const files = Object.values(req.files).flat() || [];
		res.status(201).json({
			ok: true,
			message: 'Files uploaded successfully',
			files: files.filter(Boolean).map(file => ({
				oldName: file.originalname,
				newName: file.filename,
				size: file.size,
			}))
		});
	});
};


app.post(/^\/p(\/(.*))?/, requireAuth, asyncHandler(async (req, res, next) => {
	await handleUpload(req, res, next, PUBLIC_DIR);
}));


app.post(/^\/s(\/(.*))?/, requireAuth, asyncHandler(async (req, res, next) => {
	await handleUpload(req, res, next, PRIVATE_DIR);
}));


app.delete(/^\/p(\/(.*))?/, requireAuth, asyncHandler(async (req, res) => {
	const targetPath = getSafePath(PUBLIC_DIR, req.params[1]);
	const recursive = ['true', '1', 'yes'].includes(String(req.query?.recursive).toLowerCase());

	if (targetPath === getSafePath(PUBLIC_DIR, '')) {
		const err = new Error();
		err.code = 'DELETE_ROOT';
		throw err;
	}

	const stats = await fs.stat(targetPath); // Throws ENOENT if not found
	if (!recursive && stats.isDirectory()) {
		const err = new Error();
		err.code = 'DIRECTORY_NOT_EMPTY';
		throw err;
	}

	await fs.rm(targetPath, { recursive: true, force: true });
	res.json({ ok: true, message: 'Deleted successfully' });
}));


app.delete(/^\/s(\/(.*))?/, requireAuth, asyncHandler(async (req, res) => {
	const targetPath = getSafePath(PRIVATE_DIR, req.params[1]);
	const recursive = ['true', '1', 'yes'].includes(String(req.query?.recursive).toLowerCase());

	if (targetPath === getSafePath(PRIVATE_DIR, '')) {
		const err = new Error();
		err.code = 'DELETE_ROOT';
		throw err;
	}

	const stats = await fs.stat(targetPath); // Throws ENOENT if not found
	if (!recursive && stats.isDirectory()) {
		const err = new Error();
		err.code = 'DIRECTORY_NOT_EMPTY';
		throw err;
	}

	await fs.rm(targetPath, { recursive: true, force: true });
	res.json({ ok: true, message: 'Deleted successfully' });
}));


app.put('/move', requireAuth, upload.none(), asyncHandler(async (req, res) => {
	const { from, to } = req.body;
	if (!from || !to)
		return res.status(400).json({ ok: false, error: 'Missing "from" or "to" parameters' });

	const resolveRoutePath = apiPath => {
		let path;
		if (apiPath.startsWith('p/'))
			path = getSafePath(PUBLIC_DIR, apiPath.slice(2));
		if (apiPath.startsWith('s/'))
			path = getSafePath(PRIVATE_DIR, apiPath.slice(2));
		if (path === undefined) {
			const err = new Error();
			err.code = 'UNKNOWN_PATH_PREFIX';
			throw err;
		}
		if (path === getSafePath(PUBLIC_DIR, '') || path === getSafePath(PRIVATE_DIR, '')) {
			const err = new Error('Cannot move root directory');
			err.code = 'MOVE_ROOT';
			throw err;
		}
		return path;
	};

	const fromPath = resolveRoutePath(from);
	const toPath = resolveRoutePath(to);

	await fs.stat(fromPath); // Throws ENOENT if not found
	try {
		await fs.stat(toPath); // Throws ENOENT if not found
		const err = new Error();
		err.code = 'FILE_EXISTS';
		throw err;
	} catch (err) {
	}

	await fs.mkdir(path.dirname(toPath), { recursive: true });
	try {
		try {
			await fs.rename(fromPath, toPath);
		} catch (err) {
			if (err.code === 'EXDEV') {
				// Cross-device move fallback
				await fs.copyFile(fromPath, toPath);
				await fs.rm(fromPath, { recursive: true, force: true });
			} else
				throw err;
		}
	} catch (err) {
		if (err.code === 'EINVAL')
			return res.status(403).json({ ok: false, error: 'Cannot execute operation' });
		throw err;
	}

	res.json({ ok: true, message: 'Moved successfully' });
}));


app.get('/auth', requireRoot, (req, res) => {
	const { iss, sub, exp } = req.query;
	const token = jwt.sign({}, TOKEN, {
		issuer: iss || 'QSS',
		expiresIn: exp || '1h',
		...(sub ? { subject: sub } : {})
	});

	res.status(201).json({ ok: true, token });
});


app.use((err, req, res, next) => {
	if (!err)
		return next();

	if (err.code === 'ENOENT')
		return res.status(404).json({ ok: false, error: 'File or directory not found' });
	if (err.code === 'MISSING_CONFIG')
		return res.status(500).json({ ok: false, error: 'Server configuration error: ' + err.message });
	if (err.code === 'FILE_EXISTS')
		return res.status(409).json({ ok: false, error: 'File already exists' });
	if (err.code === 'UNKNOWN_PATH_PREFIX')
		return res.status(400).json({ ok: false, error: 'Unknown path prefix' });
	if (err.code === 'DIRECTORY_NOT_EMPTY')
		return res.status(403).json({ ok: false, error: 'The directory is not empty' });
	if (err.code === 'DELETE_ROOT' || err.code === 'MOVE_ROOT')
		return res.status(403).json({ ok: false, error: 'Cannot perform this operation on the root directory' });
	if (err instanceof multer.MulterError)
		return res.status(400).json({ ok: false, error: err.message });

	const isProd = ENVIRONMENT === 'production';

	if (isNaN(parseInt(err.status, 10)) || parseInt(err.status, 10) >= 500)
		console.error(`[Error] ${req.method} ${req.url}:${err.code ? ` [${err.code}]` : ''}`, err.stack);

	res.status(err.status || 500).json({
		ok: false,
		error: (err.code && isProd ? `File error: ${err.code}` : err.message) || 'Internal Server Error',
		details: isProd ? undefined : err.stack
	});
});


app.use((req, res) => {
	res.status(404).json({ ok: false, error: 'Route not found' });
});


initStorage().then(() => {
	app.listen(PORT, () => {
		console.log(`🚀 Storage Service running in ${ENVIRONMENT} mode on port ${PORT}`);
	});
}).catch(err => {
	console.error('Failed to initialize storage directories:', err);
	process.exit(1);
});
