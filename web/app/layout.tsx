import type { Metadata } from 'next';
import { Instrument_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
const sans=Instrument_Sans({subsets:['latin'],variable:'--font-sans'});
const mono=IBM_Plex_Mono({subsets:['latin'],weight:['400','500'],variable:'--font-mono'});
export const metadata:Metadata={title:'Exchangent — Your buying desk',description:'A quieter way to buy. Give your agent the brief. Let businesses bring their best offer.'};
export default function RootLayout({children}:{children:React.ReactNode}) {
 return <html lang="en"><body className={`${sans.variable} ${mono.variable}`}>{children}</body></html>;
}
