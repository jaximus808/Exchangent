import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{source:'/:path*',headers:[
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
      {key:'X-Frame-Options',value:'SAMEORIGIN'},
    ]},
    // Connector consent: never cached, never framed (clickjacking), never leaks its query via Referer.
    {source:'/oauth/:path*',headers:[
      {key:'Cache-Control',value:'no-store'},
      {key:'Content-Security-Policy',value:"frame-ancestors 'none'"},
      {key:'Referrer-Policy',value:'no-referrer'},
    ]}];
  },
};
export default config;
