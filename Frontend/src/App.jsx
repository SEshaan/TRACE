import { useState } from 'react'
import heroImg from './assets/hero.png'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'

import { css } from "../styled-system/css";
import '../styled-system/styles.css'
import { Button } from '@/components/ui'

import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import FlowTest from './flowTest'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={reactLogo} className="framework" alt="React logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          { /* test of panda css */ }
          <h1 className={css({ bg: 'yellow.400' })}>Get started</h1>
          { /* test of ParkUI */}
          <Button>Sample Button</Button>
        </div>
      </section>
      <FlowTest />
      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  )
}

export default App
