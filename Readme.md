# Simple Storage Service API

A lightweight, secure, and fast file storage service built with Node.js and Express. It supports file uploads via `multipart/form-data` with automatic directory creation, file renaming (UUIDs), and token-based authentication.

## 📁 Public vs. Private Storage

The application is split into two distinct storage spaces, both located in the `storage/` directory by default:

* **Public Storage (storage/public)**: Designed for asset hosting. Files stored here can be downloaded or viewed by *anyone* without a token (e.g., serving images to a website). However, listing the contents of a public folder or modifying anything requires authentication. Unauthorized attempts to list a public folder will return a 404 to hide directory existence.
* **Private Storage (storage/private)**: Designed for secure data. *Every* action in this directory—viewing files, listing folders, uploading, and deleting—is protected and requires authentication.

## 🔐 Authentication

Protected routes require a Bearer token in the `Authorization` header of your HTTP request.

**Header format:**
```
Authorization: Bearer YOUR_SECRET_TOKEN
```

## 📦 Global Response Format

All API responses (except for direct file downloads and HEAD requests) return a standard JSON object.

**Success Response:**
```
{
  "ok": true,
  "message": "Optional success message",
  "content": []
}
```

**Error Response:**
```
{
  "ok": false,
  "error": "Short description of what went wrong",
  "details": "Extended error stack (only visible in development mode)"
}
```

---

## 🛣️ API Routes

### General
* **ANY /**
	* **Description**: A simple health check/welcome route.
	* **Auth**: Not required.

### Public Storage (/p/)
* **GET /p/<path>**
	* **Description**: Download a file or list a folder's contents (`{"content": [[<name>, <isFolder: 1|0>]...]}`).
	* **Auth**: Required *only* if `<path>` points to a folder. Not required for files.
	* **Responses**:
		* `200 OK`: Returns the raw file stream or directory listing array.
		* `404 Not Found`: File does not exist, or trying to list a folder without a token.

* **HEAD /p/<path>**
	* **Description**: Get file metadata (size, last modified) without downloading it.
	* **Auth**: Required *only* if `<path>` points to a folder. Not required for files.
	* **Responses**:
		* `200 OK`: Empty body, but includes `Content-Length` and `Last-Modified` headers.
		* `404 Not Found`: File does not exist, or pointing to a folder without a token.

* **POST /p/<path>**
	* **Description**: Upload files or create folders using `multipart/form-data`. Limits files to 10MB.
	* **Auth**: Required.
	* **Query Parameters**:
		* `?type=folder`: Creates a folder at the path. No file upload required.
		* `?type=files`: Uploads multiple files (up to 100) to the target directory. The files will be saved with auto-generated UUID filenames. The form-data field must be named `files`.
		* `?type=file` (defaults): Uploads a single file. The form-data field must be named `file`. The file will be saved with the exact name specified in the path.
		* `?overwrite=true`: Allows overwriting an existing file. If false/omitted, trying to overwrite a file returns a 409 Conflict.
	* **Form Field Setup** (if not using `type=folder`):
		* Default: Field name `file` (Max 1 file). Saved exactly as named in the path.
		* Multiple: Field name `files` (Requires `?type=files`).
	* **Responses**:
		* `200 OK`: Upload/Creation successful.
		* `400 Bad Request`: Multer error (e.g., file too large).
		* `409 Conflict`: File already exists (and overwrite is false).

* **DELETE /p/<path>**
	* **Description**: Deletes a file or directory (and all its contents).
	* **Auth**: Required.

### Private Storage (/s/)
* **GET /s/<path>**
	* **Description**: Download a secure file or list a folder's contents. (Same response format as `/p/` but always requires auth).
	* **Auth**: Required for all actions.

* **HEAD /s/<path>**
	* **Description**: Get file metadata or verify folder existence. (Same response format as `/p/` but always requires auth).
	* **Auth**: Required for all actions.

* **POST /s/<path>**
	* **Description**: Upload a secure file or create a private folder. (Same query params and form rules as `/p/` but always requires auth).
	* **Auth**: Required for all actions. (Same query params and form rules as `/p/`).

* **DELETE /s/<path>**
	* **Description**: Deletes a secure file or directory. (Same behavior as `/p/` but always requires auth).
	* **Auth**: Required for all actions.

### Utilities
* **PUT /move**
	* **Description**: Moves or renames a file/folder. Can move items between public and private storage.
	* **Body Requirements**: Form-data, JSON, or urlencoded containing `from` and `to` paths.
	* **Example Payload**:
		```
		{
			"from": "p/old-image.png",
			"to": "s/hidden-image.png"
		}
		```
	* **Auth**: Required.
	* **Responses**:
		* `200 OK`: Moved successfully.
		* `400 Bad Request`: Missing `from`/`to` parameters or invalid path prefixes.
		* `404 Not Found`: Source file does not exist.

### Fallback
* **404 Not Found**
	* **Description**: Any request that does not match the routes above, or an explicit file-system missing error.