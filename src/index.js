import AWS from 'aws-sdk'
import BaseStore from 'ghost-storage-base'
import { join, basename, extname } from 'path'
import Promise, { promisify } from 'bluebird'
import { readFile } from 'fs'

const readFileAsync = promisify(readFile)

const stripLeadingSlash = s => s.indexOf('/') === 0 ? s.substring(1) : s

class Store extends BaseStore {
  constructor (config = {}) {
    super(config)

    AWS.config.setPromisesDependency(Promise)

    const {
      accessKeyId,
      assetHost,
      bucket,
      pathPrefix,
      region,
      secretAccessKey,
      endpoint
    } = config

    // Compatible with the aws-sdk's default environment variables
    this.accessKeyId = process.env.AWS_ACCESS_KEY_ID || accessKeyId
    this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || secretAccessKey
    this.region = process.env.AWS_DEFAULT_REGION || region

    this.bucket = process.env.GHOST_STORAGE_ADAPTER_S3_PATH_BUCKET || bucket

    // Optional configurations
    this.host = process.env.GHOST_STORAGE_ADAPTER_S3_ASSET_HOST || assetHost || `https://s3${this.region === 'us-east-1' ? '' : `-${this.region}`}.amazonaws.com/${this.bucket}`
    this.pathPrefix = stripLeadingSlash(process.env.GHOST_STORAGE_ADAPTER_S3_PATH_PREFIX || pathPrefix || '')
    this.endpoint = process.env.GHOST_STORAGE_ADAPTER_S3_ENDPOINT || endpoint || ''
  }

  delete (fileName, targetDir) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    return new Promise((resolve, reject) => {
      return this.s3()
        .deleteObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(join(directory, fileName))
        })
        .promise()
        .then(() => resolve(true))
        .catch(() => resolve(false))
    })
  }

  generateUnique(dir, name, ext, i) {
    var self = this,
      filename,
      append = '';

    if (i) {
      append = '-' + i;
    }

    if (ext) {
      filename = name + append + ext;
    } else {
      filename = name + append;
    }

    return this.exists(filename, dir).then(function (exists) {
      if (exists) {
        i = i + 1;
        return self.generateUnique(dir, name, ext, i);
      } else {
        return join(dir, filename);
      }
    });
  }

  getUniqueFileName(image, targetDir) {
    var ext = extname(image.name),
      name;

    // Ignoring the targetDir parameter
    // since we’re uploading the image into S3
    const realTargetDir = this.getTargetDir(this.pathPrefix);

    // poor extension validation
    // .1 is not a valid extension
    let uniqueNamePromise;
    if (!ext.match(/.\d/)) {
      name = this.getSanitizedFileName(basename(image.name, ext));
      uniqueNamePromise = this.generateUnique(realTargetDir, name, ext, 0);
    } else {
      name = this.getSanitizedFileName(basename(image.name));
      uniqueNamePromise = this.generateUnique(realTargetDir, name, null, 0);
    }

    return uniqueNamePromise.then((fileName) => `${this.host}/${fileName}`);
  }

  exists (fileName, targetDir) {
    return new Promise((resolve, reject) => {
      return this.s3()
        .getObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(join(targetDir, fileName))
        })
        .promise()
        .then(() => resolve(true))
        .catch(() => resolve(false))
    })
  }

  s3 () {
    const options = {
      accessKeyId: this.accessKeyId,
      bucket: this.bucket,
      region: this.region,
      secretAccessKey: this.secretAccessKey
    }
    if (this.endpoint !== '') {
      options.endpoint = this.endpoint
    }
    return new AWS.S3(options)
  }

  save (image, targetDir) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    return new Promise((resolve, reject) => {
      Promise.all([
        this.getUniqueFileName(image, directory),
        readFileAsync(image.path)
      ]).then(([ fileName, file ]) => {
        const fileNameWithoutHost = fileName.replace(this.host + '/', '');

        this.s3()
          .putObject({
            ACL: 'public-read',
            Body: file,
            Bucket: this.bucket,
            CacheControl: `max-age=${30 * 24 * 60 * 60}`,
            ContentType: image.type,
            Key: stripLeadingSlash(fileNameWithoutHost)
          })
          .promise()
          .then(() => resolve(`${this.host}/${fileNameWithoutHost}`))
      }).catch(error => reject(error))
    })
  }

  serve () {
    return (req, res, next) => {
      this.s3()
        .getObject({
          Bucket: this.bucket,
          Key: `${this.pathPrefix}/${stripLeadingSlash(req.path)}`
        }).on('httpHeaders', function (statusCode, headers, response) {
          res.set(headers)
        })
            .createReadStream()
            .on('error', function (err) {
              res.status(404)
              next(err)
            })
            .pipe(res)
    }
  }

  read (options) {
    options = options || {}

    return new Promise((resolve, reject) => {
      // remove trailing slashes
      let path = (options.path || '').replace(/\/$|\\$/, '')

      // check if path is stored in s3 handled by us
      if (!path.startsWith(this.host)) {
        reject(new Error(`${path} is not stored in s3`))
      }

      path = path.substring(this.host.length)

      this.s3()
        .getObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(path)
        })
        .promise()
        .then((data) => resolve(data.Body))
        .catch(error => reject(error))
    })
  }
}

export default Store
