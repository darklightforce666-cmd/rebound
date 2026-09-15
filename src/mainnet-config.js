/* Public addresses only. RPC credentials belong in Netlify Functions. */
(function (root) {
  'use strict';
  const config = Object.freeze({
    cluster: 'mainnet-beta',
    mint: '3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump',
    chainEndpoint: '/.netlify/functions/chain',
    rewardsAvailable: false,
    launchesAvailable: false
  });
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.ReboundConfig = config;
})(typeof window === 'object' ? window : globalThis);
