// TODO: port from platform
import { useNavigate, useParams, useSearchParams } from "react-router";

export interface AppRoutingAdapter {
  navigate: ReturnType<typeof useNavigate>;
  params: ReturnType<typeof useParams>;
  searchParams: ReturnType<typeof useSearchParams>[0];
}

export function useAppRouting(): AppRoutingAdapter {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  return { navigate, params, searchParams };
}

export function useAppNavigate() {
  const navigate = useNavigate();
  return {
    push: (path: string) => navigate(path),
    replace: (path: string) => navigate(path, { replace: true }),
  };
}

export function useAppSearchParams() {
  const [searchParams] = useSearchParams();
  return searchParams;
}

export { useNavigate, useParams, useSearchParams };
export function useRouter() {
  const navigate = useNavigate();
  return { push: (path: string) => navigate(path), replace: (path: string) => navigate(path, { replace: true }) };
}
