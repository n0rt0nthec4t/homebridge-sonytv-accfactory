// Utility Helpers
// Part of homebridge-sonytv-accfactory
//
// Provides the shared validation, scaling, hashing, and HTTP helpers used by
// the Sony platform and television modules.
//
// Responsibilities:
// - Scale Sony values into HomeKit ranges
// - Generate stable input identifiers
// - Perform fetch requests with timeouts, retries, and structured errors
//
// Notes:
// - fetchWrapper() follows the common helper used by homebridge-nest-accfactory
// - Network tests replace the global fetch boundary for deterministic results
//
// Code version 2026.09.10
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';

// Define constants
const CRC32_HASH_TABLE = [
  0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 0x00edb8832, 0x079dcb8a4,
  -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22,
  0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9,
  -0x5f0c29d, -0x72f7f20b, 0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95,
  0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 0x026d930ac, 0x051de003a,
  -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc,
  0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f,
  -0x60401b5b, -0x17472bcd, 0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff,
  0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 0x065b0d9c6, 0x012b7e950,
  -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e,
  0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5,
  -0x55f5b3a1, -0x22f28337, 0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61,
  0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, -0x12477ce0, -0x65404c4a,
  0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8,
  -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835,
  0x0196c3671, 0x06e6b06e7, -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5,
  -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, -0x27f2d426, -0x50f5e4b4,
  0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236,
  -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf,
  0x02cd99e8b, 0x05bdeae1d, -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713,
  -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, -0x792c2d2c, -0xe2b1dbe,
  0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c,
  -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909,
  0x04969474d, 0x03e6e77db, -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9,
  -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, -0x4c9985d2, -0x3b9eb548,
  0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d,
];

function crc32(value) {
  var crc32 = 0xffffffff; // init crc32 hash;
  value = Buffer.from(value); // convert value into buffer for processing
  for (var index = 0; index < value.length; index++) {
    crc32 = (CRC32_HASH_TABLE[(crc32 ^ value[index]) & 0xff] ^ (crc32 >>> 8)) & 0xffffffff;
  }
  crc32 ^= 0xffffffff;
  return crc32 >>> 0; // return crc32
}

function scaleValue(value, sourceMin, sourceMax, targetMin, targetMax) {
  // Validate numeric inputs
  if (
    Number.isFinite(Number(value)) !== true ||
    Number.isFinite(Number(sourceMin)) !== true ||
    Number.isFinite(Number(sourceMax)) !== true ||
    Number.isFinite(Number(targetMin)) !== true ||
    Number.isFinite(Number(targetMax)) !== true
  ) {
    return undefined;
  }

  value = Number(value);
  sourceMin = Number(sourceMin);
  sourceMax = Number(sourceMax);
  targetMin = Number(targetMin);
  targetMax = Number(targetMax);

  // Prevent divide-by-zero scaling range
  if (sourceMax === sourceMin) {
    return targetMin;
  }

  // Clamp source value to input range
  value = Math.max(sourceMin, Math.min(sourceMax, value));

  // Scale value proportionally into target range
  return ((value - sourceMin) * (targetMax - targetMin)) / (sourceMax - sourceMin) + targetMin;
}

async function fetchWrapper(method, url, options = {}, data) {
  // Only support GET and POST requests
  // Invalid inputs fail silently to match existing helper behaviour
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  // Retry count configuration
  // Defaults to a single attempt if not specified
  let retry = Number.isFinite(Number(options.retry)) === true && Number(options.retry) > 0 ? Number(options.retry) : 1;
  let retryCount = Number.isFinite(Number(options._retryCount)) === true ? Number(options._retryCount) : 0;

  // Clone fetch options so we can safely remove internal-only fields
  let fetchOptions = {
    ...options,
    method,
    _retryCount: retryCount,
  };

  // Remove internal helper options before passing to fetch()
  delete fetchOptions.retry;
  delete fetchOptions.timeout;
  delete fetchOptions._retryCount;
  delete fetchOptions.signal;

  // Apply timeout using AbortSignal if configured
  if (Number.isFinite(Number(options?.timeout)) === true && Number(options.timeout) > 0) {
    fetchOptions.signal = AbortSignal.timeout(Number(options.timeout));
  }

  // Process POST body handling
  if (method === 'post' && data !== undefined) {
    // Automatically serialise plain objects as JSON
    if (typeof data === 'object' && data !== null && data.constructor === Object) {
      fetchOptions.body = JSON.stringify(data);
      fetchOptions.headers ??= {};

      // Apply JSON content type if not already specified
      if (fetchOptions.headers['Content-Type'] === undefined) {
        fetchOptions.headers['Content-Type'] = 'application/json';
      }
    } else {
      // Pass through raw body types unchanged
      fetchOptions.body = data;
    }
  }

  try {
    // Perform request
    // eslint-disable-next-line no-undef
    let response = await fetch(url, {
      ...fetchOptions,
      ...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    });

    // HTTP request completed but returned non-success status
    if (response?.ok === false) {
      // Only retry transient/server-side failures
      // Do not retry authentication or client configuration failures
      let retryableStatus = [408, 429, 500, 502, 503, 504].includes(response.status) === true;

      if (retry > 1 && retryableStatus === true) {
        // Exponential backoff delay
        let delay = 500 * Math.pow(2, retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));

        return fetchWrapper(
          method,
          url,
          {
            ...options,
            retry: retry - 1,
            _retryCount: retryCount + 1,
          },
          data,
        );
      }

      // Attempt to capture response body for debugging
      let body = '';
      try {
        body = await response.text();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Ignore body parsing failures
      }

      throw Object.assign(
        new Error(
          'HTTP ' +
            response.status +
            ' on ' +
            method.toUpperCase() +
            ' ' +
            url +
            ': ' +
            (typeof response.statusText === 'string' && response.statusText !== '' ? response.statusText : 'Unknown error'),
        ),
        {
          code: response.status,
          status: response.status,
          body,
        },
      );
    }

    return response;
  } catch (error) {
    // Preserve original/root cause where available
    let original = error?.cause ?? error;

    // Determine whether failure is considered transient/retryable
    let retryable =
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
      error?.name === 'TypeError' ||
      original?.name === 'AbortError' ||
      original?.name === 'TimeoutError' ||
      original?.name === 'TypeError' ||
      original?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      original?.code === 'UND_ERR_CONNECT_TIMEOUT';

    // Invalid URLs should fail immediately
    if (original?.code === 'ERR_INVALID_URL') {
      throw Object.assign(new Error('Invalid URL: ' + url), {
        code: 'ERR_INVALID_URL',
        cause: original,
      });
    }

    // Retry transient transport/network failures
    if (retry > 1 && retryable === true) {
      // Exponential backoff delay
      let delay = 500 * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(
        method,
        url,
        {
          ...options,
          retry: retry - 1,
          _retryCount: retryCount + 1,
        },
        data,
      );
    }

    // Final wrapped error after all retry attempts exhausted
    throw Object.assign(
      new Error(
        method.toUpperCase() +
          ' ' +
          url +
          ' failed after ' +
          (retryCount + 1) +
          ' attempt' +
          (retryCount + 1 > 1 ? 's' : '') +
          ': ' +
          (typeof original?.message === 'string' && original.message !== '' ? original.message : String(original)),
      ),
      {
        code: original?.code,
        cause: original,
      },
    );
  }
}

// Define exports
export { crc32, scaleValue, fetchWrapper };
