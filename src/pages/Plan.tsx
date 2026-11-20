import { Navigate, useParams } from 'react-router-dom';

/** Plans now open as a pop-up on the calendar; old /plan links land there. */
export function PlanPage() {
  const { id } = useParams();
  return <Navigate to={`/calendar?open=event:${id}`} replace />;
}
