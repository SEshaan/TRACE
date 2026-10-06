import { css } from '../styled-system/css'
import '../styled-system/styles.css'
import { Button } from '@/components/ui'
import FlowTest from './flowTest'

function App() {
  return (
    <main
      className={css({
        display: 'grid',
        gridTemplateColumns: { base: '1fr', lg: '220px minmax(0, 1fr) 280px' },
        gridTemplateRows: { base: 'auto auto auto auto', lg: '1fr 180px' },
        minH: '100vh',
        bg: 'gray.50',
        color: 'gray.900',
      })}
    >
      <aside
        className={css({
          gridRow: { lg: '1 / 3' },
          display: 'flex',
          flexDir: 'column',
          gap: '4',
          p: '4',
          bg: 'white',
          borderRightWidth: { lg: '1px' },
          borderBottomWidth: { base: '1px', lg: '0' },
          borderColor: 'gray.200',
        })}
      >
        <div>
          <p className={css({ fontSize: 'sm', color: 'gray.500' })}>TRACE</p>
          <h1 className={css({ fontSize: 'xl', fontWeight: 'bold' })}>Explorer</h1>
        </div>
        <input
          className={css({
            w: 'full',
            h: '10',
            px: '3',
            borderWidth: '1px',
            borderColor: 'gray.300',
            borderRadius: 'md',
            bg: 'white',
          })}
          placeholder="Search queries"
          aria-label="Search queries"
        />
        <div className={css({ display: 'flex', gap: '2' })}>
          <Button size="sm" variant="outline">All</Button>
          <Button size="sm" variant="outline">Success</Button>
          <Button size="sm" variant="outline">Failed</Button>
        </div>
        <Button variant="outline">+ New query</Button>
        <div className={css({ display: 'grid', gap: '2', fontSize: 'sm' })}>
          <strong>□ university.sqlite</strong>
          <span className={css({ pl: '4', color: 'green.700' })}>● GPA above 8...</span>
          <span className={css({ pl: '4', color: 'red.700' })}>● Faculty per department</span>
          <strong>□ library.sqlite</strong>
          <strong>□ hospital.sqlite</strong>
        </div>
        <Button variant="outline" mt="auto">+ Add database</Button>
      </aside>

      <section
        className={css({
          minW: '0',
          display: 'grid',
          gridTemplateRows: 'auto minmax(360px, 1fr)',
          bg: 'white',
        })}
      >
        <header className={css({ display: 'grid', gap: '3', p: '4', borderBottomWidth: '1px', borderColor: 'gray.200' })}>
          <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '3' })}>
            <div>
              <p className={css({ fontSize: 'sm', color: 'gray.500' })}>university.sqlite</p>
              <h2 className={css({ fontSize: 'lg', fontWeight: 'semibold' })}>GPA above 8 and more than 3 courses</h2>
            </div>
            <span className={css({ color: 'green.700', fontSize: 'sm', fontWeight: 'medium' })}>Success</span>
          </div>
          <div className={css({ display: 'flex', gap: '3' })}>
            <input
              className={css({ flex: '1', minW: '0', h: '10', px: '3', borderWidth: '1px', borderColor: 'gray.300', borderRadius: 'md' })}
              defaultValue="Students with GPA above 8 enrolled in more than 3 courses"
              aria-label="Query request"
            />
            <Button>Run</Button>
          </div>
        </header>
        <div className={css({ minH: '0', overflow: 'hidden', position: 'relative' })}>
          <FlowTest />
        </div>
      </section>

      <aside className={css({ p: '4', bg: 'white', borderLeftWidth: { lg: '1px' }, borderColor: 'gray.200' })}>
        <p className={css({ fontSize: 'sm', color: 'gray.500' })}>Node details</p>
        <h2 className={css({ mt: '1', fontSize: 'lg', fontWeight: 'semibold' })}>Select a node</h2>
        <p className={css({ mt: '2', fontSize: 'sm', color: 'gray.600' })}>Details for the selected query action will appear here.</p>
      </aside>

      <section className={css({ gridColumn: { lg: '2 / 4' }, p: '4', bg: 'white', borderTopWidth: '1px', borderColor: 'gray.200' })}>
        <div className={css({ display: 'flex', gap: '5', borderBottomWidth: '1px', borderColor: 'gray.200' })}>
          <strong className={css({ pb: '2', borderBottomWidth: '2px', borderColor: 'blue.600' })}>Final SQL</strong>
          <span className={css({ color: 'gray.500' })}>Results</span>
          <span className={css({ color: 'gray.500' })}>Summary</span>
        </div>
        <pre className={css({ mt: '3', whiteSpace: 'pre-wrap', fontSize: 'sm', color: 'gray.700' })}>SELECT s.name FROM Student s JOIN Enrollment e ON s.id = e.student_id;</pre>
      </section>
    </main>
  )
}

export default App
